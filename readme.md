# SCIM gateway

Sample code showing how a SCIM client can interact with the MyID Core API. This is based on the https://github.com/jelhub/scimgateway project.

A Postman test collection is included for various scenarios.

Note that implementation of MyID Core API connectivity is with plugin-scim, and plugin-loki is included to show general SCIM behaviour.

# Requirements

MyID Core API authentication needs to be turned off for testing (`MyID.Auth.AnonymousAccess = true` in _rest.core/appSettings.json_)

Start with `npm run dev` (when developing) or `npm start` to launch two webservices:

- localhost:8880 - plugin-loki - supports SCIM requests
- localhost:8886 - plugin-scim - connects to MyID Core API, with limited SCIM support. Ongoing development is on this end-point

## License

Copyright (c) 2016 Jarle Elshaug

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
