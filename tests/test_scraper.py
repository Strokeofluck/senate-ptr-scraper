import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pandas as pd
import requests

from scripts import scrape_senate_ptrs as scraper


def response(status=200, body="", url=scraper.SEARCH_URL):
    result = requests.Response()
    result.status_code = status
    result._content = body.encode()
    result.url = url
    return result


def session(token="fresh", post_status=200):
    client = Mock()
    client.get.return_value = response(body=f'<input name="csrfmiddlewaretoken" value="{token}">')
    client.post.return_value = response(post_status)
    client.cookies = {"csrftoken": token}
    return client


class AgreementTests(unittest.TestCase):
    def test_source_403_waits_for_later_recovery_instead_of_retrying(self):
        rejected = session("old", 403)
        accepted = session("new")
        with patch.object(scraper, "build_session", side_effect=[rejected, accepted]) as build, patch.object(scraper.time, "sleep") as sleep:
            with self.assertRaises(scraper.SenateAccessError):
                scraper.establish_senate_session()
        build.assert_called_once()
        rejected.close.assert_called_once()
        accepted.post.assert_not_called()
        sleep.assert_not_called()

    def test_persistent_network_failure_stops_after_two_sessions(self):
        clients = [session() for _ in range(2)]
        for client in clients:
            client.get.side_effect = requests.Timeout("source timeout")
        with patch.object(scraper, "build_session", side_effect=clients) as build, patch.object(scraper.time, "sleep") as sleep:
            with self.assertRaises(requests.Timeout):
                scraper.establish_senate_session()
        self.assertEqual(build.call_count, 2)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [60])
        for client in clients:
            client.close.assert_called_once()

    def test_network_timeout_recovers(self):
        rejected, accepted = session(), session()
        rejected.get.side_effect = requests.Timeout("source timeout")
        with patch.object(scraper, "build_session", side_effect=[rejected, accepted]), patch.object(scraper.time, "sleep") as sleep:
            self.assertIs(scraper.establish_senate_session()[0], accepted)
        sleep.assert_called_once_with(60)
        self.assertEqual(accepted.post.call_args.kwargs["data"]["csrfmiddlewaretoken"], "fresh")
        self.assertEqual(accepted.post.call_args.kwargs["headers"]["Origin"], scraper.ROOT)

    def test_non_retryable_http_error_fails_immediately(self):
        client = session(post_status=404)
        with patch.object(scraper, "build_session", return_value=client) as build, patch.object(scraper.time, "sleep") as sleep:
            with self.assertRaises(requests.HTTPError):
                scraper.establish_senate_session()
        build.assert_called_once()
        sleep.assert_not_called()
        client.close.assert_called_once()

    def test_missing_form_token_fails_without_retry(self):
        client = session()
        client.get.return_value = response(body="form changed")
        with patch.object(scraper, "build_session", return_value=client), patch.object(scraper.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "CSRF token"):
                scraper.establish_senate_session()
        sleep.assert_not_called()
        client.close.assert_called_once()

    def test_returned_agreement_is_not_success(self):
        client = session()
        client.post.return_value = response(body='<input name="prohibition_agreement">')
        with self.assertRaises(scraper.SenateAccessError):
            scraper.accept_senate_agreement(client)

    def test_403_error_does_not_expose_response_secrets(self):
        denied = response(403, '<h1>CSRF failed</h1><input value="secret-cookie">')
        with self.assertRaisesRegex(scraper.SenateAccessError, "CSRF validation") as error:
            scraper.check_senate_response(denied, "during agreement")
        self.assertNotIn("secret-cookie", str(error.exception))


class OutputProtectionTests(unittest.TestCase):
    def test_filing_403_stops_remaining_requests(self):
        client = Mock()
        client.get.return_value = response(403)
        filings = pd.DataFrame([
            {"report_id": str(i), "filing_format": "electronic_html", "report_url": "https://example.com/ptr/", "filer_name": "Test"}
            for i in range(2)
        ])
        with patch.object(scraper, "RESUME_EXISTING", False), patch.object(scraper.time, "sleep"):
            with self.assertRaises(scraper.SenateAccessError):
                scraper.scrape_electronic_filings(client, filings)
        client.get.assert_called_once()

    def test_invalid_or_empty_search_keeps_existing_index(self):
        for payload in [{}, {"data": {}}, {"data": []}, {"data": [], "recordsFiltered": 100}]:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "index.csv"
                target.write_text("last good index")
                with patch.object(scraper, "FILING_INDEX_CSV", target), patch.object(scraper, "search_ptr_batch", return_value=payload):
                    with self.assertRaises(RuntimeError):
                        scraper.build_filing_index(Mock(), "token")
                self.assertEqual(target.read_text(), "last good index")

    def test_partial_search_page_is_rejected(self):
        row = ["Test", "Senator", "Senator", '<a href="/search/view/ptr/report-1/">PTR</a>', "10/22/2026"]
        with patch.object(scraper, "search_ptr_batch", return_value={"data": [row], "recordsFiltered": 200}):
            with self.assertRaisesRegex(RuntimeError, "incomplete page"):
                scraper.build_filing_index(Mock(), "token")

    def test_failed_electronic_filing_does_not_publish_or_advance_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = {name: Path(directory) / name for name in ["FILING_INDEX_CSV", "TRANSACTIONS_CSV", "STATUS_CSV", "METADATA_JSON"]}
            for path in paths.values():
                path.write_text("last good output")
            client = Mock()
            with patch.multiple(scraper, **paths), patch.object(scraper, "establish_senate_session", return_value=(client, "token")), patch.object(scraper, "build_filing_index", return_value=pd.DataFrame()), patch.object(scraper, "scrape_electronic_filings", return_value=(pd.DataFrame(), [])), patch.object(scraper, "build_status_table", return_value=pd.DataFrame([{"status": "error"}])):
                with self.assertRaisesRegex(RuntimeError, "keeping existing CSVs and metadata"):
                    scraper.main()
            for path in paths.values():
                self.assertEqual(path.read_text(), "last good output")
            client.close.assert_called_once()

    def test_cached_official_html_still_parses(self):
        path = sorted(scraper.RAW_DIR.glob("*.html"))[0]
        rows, error = scraper.parse_electronic_ptr(path.read_text(encoding="utf-8"), {"report_id": path.stem})
        self.assertIsNone(error)
        self.assertGreater(len(rows), 0)
        self.assertTrue(all(len(row["transaction_id"]) == 64 for row in rows))

    def test_successful_scrape_publishes_complete_outputs(self):
        import json

        with tempfile.TemporaryDirectory() as directory:
            paths = {name: Path(directory) / name for name in ["FILING_INDEX_CSV", "TRANSACTIONS_CSV", "STATUS_CSV", "METADATA_JSON"]}
            filing = {"report_id": "report-1", "report_key": "report-1", "filing_format": "electronic_html",
                      "filer_name": "Test Senator", "filing_date": "2026-10-22", "report_url": "https://example.com/ptr/"}
            client = session()
            html = sorted(scraper.RAW_DIR.glob("*.html"))[0].read_text(encoding="utf-8")
            client.get.return_value = response(body=html)
            with patch.multiple(scraper, **paths), patch.object(scraper, "SAVE_ELECTRONIC_HTML", False), patch.object(scraper, "establish_senate_session", return_value=(client, "token")), patch.object(scraper, "search_ptr_batch", return_value={"data": [["Test", "Senator", "Senator", '<a href="/search/view/ptr/report-1/">PTR</a>', "10/22/2026"]], "recordsFiltered": 1}), patch.object(scraper.time, "sleep"):
                scraper.main()
            metadata = json.loads(paths["METADATA_JSON"].read_text())
            self.assertEqual(metadata["filings_total"], 1)
            self.assertGreater(metadata["electronic_transactions"], 0)
            self.assertEqual(metadata["status_counts"], {"ok": 1})
            self.assertEqual(len(pd.read_csv(paths["FILING_INDEX_CSV"])), 1)
            self.assertEqual(pd.read_csv(paths["STATUS_CSV"])["status"].tolist(), ["ok"])
            client.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
