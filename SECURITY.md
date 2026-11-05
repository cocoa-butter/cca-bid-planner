# Security

## Scope

cca-bid-planner is read-only. It never asks for, stores or uses private keys, and it never
sends transactions. The `calldata` command only encodes `submitBid` arguments for you to
review and send with a wallet of your choice.

Issues that matter most here:

- A planner or simulator result that differs from what the deployed contract would do.
  The engine is checked against the real contract in `test/differential.test.ts`; a case
  that diverges is a security bug.
- Calldata that encodes something other than what the CLI prints.
- Anything that causes the tool to contact a host other than the RPC URL you pass.

Bugs in the CCA contracts themselves are out of scope here. Report those to Uniswap Labs
through their bug bounty (linked from the upstream repository README).

## Reporting

Please report privately via GitHub security advisories on this repository
("Security" tab, "Report a vulnerability"). Do not open a public issue for an
unpatched problem. You should get a reply within a week.
