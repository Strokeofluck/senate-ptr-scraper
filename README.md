# Senate PTR Scraper

Collects official U.S. Senate Periodic Transaction Reports (PTRs) from the Senate Electronic Financial Disclosure system and converts electronic filings into structured transaction data.

Unlike House PTRs, many Senate filings are available as structured HTML. This repository focuses on those electronic filings while keeping paper filings visible in the filing index for separate processing.

## Official source

Senate PTR data is retrieved from the U.S. Senate Electronic Financial Disclosure system:

https://efdsearch.senate.gov/

The scraper accepts the site's disclosure agreement, searches the official PTR index for the configured date range, and follows each electronic filing to its transaction table.

## What the scraper does

1. Searches the official Senate eFD PTR index for a configurable date range.
2. Identifies electronic and paper filings.
3. Parses transaction tables from electronic PTRs.
4. Saves the official filing HTML for archival and verification.
5. Maintains filing-index, transaction, and scrape-status CSVs.
6. Reuses previously parsed electronic filings on later runs.

Paper filings are recorded but intentionally not parsed by this pipeline. They are marked `paper_deferred` for separate document-processing work.

## Repository data

Automated runs write into `data/`:

```text
data/
├── 01_html/           archived HTML for electronic filings
├── 02_filing_index/   senate_ptr_filing_index.csv
├── 03_transactions/   senate_ptr_transactions_electronic.csv
├── 04_status/         senate_ptr_scrape_status.csv
└── senate_ptr_metadata.json
```

The transaction CSV is the main structured output for downstream analysis and the portfolio site. `senate_ptr_metadata.json` summarizes update time, filing counts, transaction counts, latest dates, and scrape-status totals.

## Automation

The repository includes a GitHub Actions workflow at `.github/workflows/scrape.yml`.

It runs daily at approximately **9:30 AM U.S. Eastern**, installs the Python requirements, runs the scraper, commits updated data back to the repository, and can notify the `sean-data-portfolio` repository to rebuild when new Senate data is available.

The workflow also supports manual date-range overrides.

An evening recovery check runs at **01:30 UTC**, roughly half a day after the daily
scrape. It allows one additional runner attempt only when the latest scrape failed
at least six hours ago and within the past day. Recovery only applies to scheduled
or manual runs on `main`; commit/push and portfolio-rebuild failures are left for inspection.
Concurrent data updates are serialized. Manual runs on other branches can validate
the scraper without committing data or requesting a portfolio rebuild.

## Run locally

Create a virtual environment and install the requirements:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Run the scraper:

```powershell
python scripts/scrape_senate_ptrs.py
```

## Configuration

Runtime settings can be changed with environment variables:

```text
SENATE_PTR_START_DATE
SENATE_PTR_END_DATE
SENATE_PTR_BATCH_SIZE
SENATE_PTR_REQUEST_DELAY
SENATE_PTR_MAX_SEARCH_PAGES
SENATE_PTR_SAVE_HTML
SENATE_PTR_RESUME_EXISTING
```

The default date range begins on `2021-01-01` and ends on the current date.

Example:

```powershell
$env:SENATE_PTR_START_DATE="2025-01-01"
$env:SENATE_PTR_REQUEST_DELAY="2.0"
python scripts/scrape_senate_ptrs.py
```

## Electronic vs. paper filings

This distinction is important:

**Electronic PTRs** are parsed from the official Senate HTML transaction table.

**Paper PTRs** remain in the filing index but are not downloaded or extracted here.

Keeping those records in the index makes the gap explicit instead of silently excluding filings the current parser cannot handle.

## Reliability and source preservation

The scraper keeps the official HTML for electronic filings so parsed records can be checked against the source.

Requests include retry handling and a configurable delay between calls (two seconds
by default). Agreement
requests send the source Origin and Referer headers, and fetch the form without
using a cached response. An HTTP 403 stops the entire scrape immediately, including
when downloading filings, to give the source time to recover. Temporary network failures allow one fresh-session retry
after a full minute. Persistent rejection still fails visibly.

The separate `.github/workflows/recover-scrape.yml` workflow retries failed scraper
jobs on fresh GitHub-hosted runners, with a maximum of two total runner attempts
per run and a minimum six-hour cooldown. It checks the latest scrape and rechecks
the run before retrying to avoid duplicating a manual retry. The scheduled check
does not keep a runner waiting through the cooldown.
This workflow must be on the default branch to run. It requires only read access to
contents and write access to Actions, and executes only trusted default-branch code.

CSV outputs and the metadata update time are written only after search results and
all electronic filings pass validation. Missing search data, an incomplete search,
HTTP errors, or unparsed filings preserve the last published CSVs and metadata.
Empty searches fail conservatively instead of replacing existing data with an empty
index. Successfully downloaded HTML can remain locally for inspection after a failed run.

The Senate's own access controls or an outage can still prevent collection, including
from an ordinary browser. Retries cannot guarantee access; after the bounded retries,
the run remains failed and the next daily run tries again.

Regression checks run on pull requests and scraper changes. Monthly Dependabot
pull requests keep GitHub Actions versions current without automatically merging
dependency upgrades. To run the checks locally:

```powershell
python -m unittest discover -s tests -v
node --test tests/recover-scrape.test.cjs
```

A hard pagination limit is also used to prevent runaway searches if the eFD response format changes unexpectedly.

## Original notebook

The exploratory Colab version remains available at:

`notebooks/Scrape_Official_Senate_PTRs_Electronic_Only.ipynb`

The notebook is useful for manual or exploratory work. The production automation uses `scripts/scrape_senate_ptrs.py`.
