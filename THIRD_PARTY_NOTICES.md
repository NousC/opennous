# Third-party notices

Code in this repository that is adapted from other projects, with the license it came under.

This file covers the Cloud layer (`src/cloud/` folders), which is not part of the public export, and
is excluded from it with that code (see `public-export.json`). If public code ever adapts third-party
code, give it its own entry in a notices file that is exported.

## Hindsight

- Project: Hindsight, https://github.com/vectorize-io/hindsight
- Used in: `apps/api/src/cloud/lib/livingDoc.mjs` (GET-1054). The document model for Intelligence
  files (markdown split into sections and blocks with persistent `b` + sha1 ids, and rendered back),
  the eight edit operations and how they are validated and applied, and the editing rules in the
  edit prompt, adapted from `hindsight_api/engine/reflect/structured_doc.py`, `delta_ops.py` and
  `prompts.py` (`STRUCTURED_DELTA_SYSTEM_PROMPT`).
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
