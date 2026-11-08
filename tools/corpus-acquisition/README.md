# Direct Wikimedia source streaming

Run `python prepare-full-wikipedia.py` to fetch the matching compressed indexes from the pinned 19-edition plan. Then run `python prepare-remote-wikipedia.py` to check those indexes and prepare small URL/checksum/ETag source manifests. XML dumps stay at Wikimedia and are read in indexed HTTP ranges by the existing V3 ingestor.

See [Wikipedia HTTP streaming](../../docs/WIKIPEDIA_HTTP_STREAMING.md) for configuration, firehose continuation, source identity and checksum qualification. GitHub Actions is not required.

The prepared files remain under the ignored `corpus-build/` folder. Acquiring indexes and preparing manifests does not train a brain. The Klingon Wikimedia edition is unavailable; that absence remains explicit in the plan.
