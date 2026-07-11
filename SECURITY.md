# Security policy

Spectator sits between a private agent session and a potentially public audience. Please treat possible data exposure, authentication bypasses, unsafe binding behavior, and redaction failures as security issues.

## Reporting a vulnerability

Do not open a public issue with exploit details, credentials, raw Hermes frames, or private session data. Use GitHub's **Security** tab and select **Report a vulnerability** to send a private report to the maintainer:

https://github.com/MustafaK99/spectator/security/advisories/new

Include the affected version, reproduction steps using synthetic data, impact, and any suggested mitigation. You should receive an acknowledgement within seven days. Please allow time for a fix and coordinated disclosure.

## Supported versions

Until the project reaches 1.0, security fixes are made against the latest release only.

## Safe operation

Keep Hermes and the Spectator tap on loopback, use a random viewer key, leave raw tool output disabled for public sessions, and stop the public tunnel after a broadcast. Never share a session containing data you would not show directly to the audience.
