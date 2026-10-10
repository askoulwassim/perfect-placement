# Third-party notices

## AfterShip/email-verifier

`packages/engine/people/lists/aftership.ts` vendors data (not code) from [AfterShip/email-verifier](https://github.com/AfterShip/email-verifier): the role-account list (`metadata_role.go`) and the free-provider list (`metadata_free.go`) in full, and a trimmed subset of the disposable-domain list (`metadata_disposable.go`: the domains whose name carries a throwaway marker), taken at commit `a97c75ff8da09ebfcd30011197cacc78b1c5458e`. It is used only for local list lookups; nothing contacts a mail server.

```
MIT License

Copyright (c) 2020 AfterShip

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
