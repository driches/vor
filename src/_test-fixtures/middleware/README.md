# middleware test fixtures

Test fixture for the code-review GitHub Action. Deliberately contains subtle bugs
in plausible-looking auth, SSRF-guard, rate-limit, and audit middleware code.

**Not for production use.** These files are not imported anywhere; they exist so
the AI reviewer has realistic, non-obvious targets to flag.
