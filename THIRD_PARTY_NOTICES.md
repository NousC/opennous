# Third-party notices

Code in this repository that is ported from, or closely follows, another project's source is
listed here with that project's license. One section per project.

## Hindsight

- Source: https://github.com/vectorize-io/hindsight
- Used in: `packages/core/src/db/temporalWindow.ts` (ported from `temporal_periods.py`),
  `packages/core/src/db/hybridSearch.ts` (reciprocal rank fusion from `search/fusion.py`, OR-joined
  full-text terms from `sql/postgresql.py`, token-budget selection from `fact_budget.py`, the
  shared-entity link score from `memories/pg/link_expansion.py`), GET-1056.
  `packages/core/src/db/marketEntities.ts` (the name matcher, from `entity_resolver.py`), GET-1049.
- License: MIT

```
MIT License

Copyright (c) 2025 Vectorize AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
