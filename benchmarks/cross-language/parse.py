#!/usr/bin/env python3
"""Cross-language parse benchmark: python-docx.

Parses each fixture passed as an argument N times and prints, as JSON on
stdout, the median wall time per parse in milliseconds (excluding interpreter
startup + import). The TypeScript runner spawns this and tabulates the numbers
next to folio and the other implementations.
"""

import json
import sys
import time
from statistics import median

import docx

ITERATIONS = 20


def bench(path: str) -> float:
    samples = []
    for _ in range(ITERATIONS):
        start = time.perf_counter()
        docx.Document(path)
        samples.append((time.perf_counter() - start) * 1000.0)
    return median(samples)


def main() -> None:
    results = [{"path": path, "median_ms": bench(path)} for path in sys.argv[1:]]
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
