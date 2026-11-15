# Conformance

Generated from `spec/*.json` and the tests that cite a requirement id (`itReq`). Do not edit by hand:
`UPDATE_CONFORMANCE=1 npx vitest run src/conformance.meta.test.ts` rewrites it.

Required requirements with a test: **319 of 319**.

## rfc5545.json

| Id | Level | Status | Tests |
|---|---|---|---|
| [`RFC5545:3.1:line-length-75-octets`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | SHOULD NOT | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:fold-long-lines`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | SHOULD | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:fold-crlf-plus-wsp`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | MAY | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:unfold-removes-one-wsp`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:unfold-before-parse`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:utf8-unfold-restores-sequence`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | policy | required | `src/conformance/syntax.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC5545:3.1:utf8-fold-4-byte-chars`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | policy | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:crlf-line-break`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:parse-bare-lf-lenient`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | policy | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:names-case-insensitive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1.1:list-values-comma`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1.1) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.1.1:structured-values-semicolon`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1.1) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.1.1:param-list-semicolon`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1.1) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1.1:param-special-chars-quoted`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1.1) | MUST | required | `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2:param-value-quoted-string`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2:param-value-no-dquote`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2) | MUST NOT | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2:ignore-unknown-x-iana-param`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2) | MUST | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC5545:3.2.1:altrep-quoted-uri`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.1) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.3:cutype-default-individual`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.4:delegated-addresses-quoted`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.4) | MUST | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.7:binary-requires-base64-encoding`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.7) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.7:encoding-default-8bit`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.7) | policy | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.12:partstat-values-match-component`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.12) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.2.12:partstat-default-needs-action`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.12) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.12:partstat-unknown-as-needs-action`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.12) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.13:range-only-thisandfuture`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.13) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.2.13:thisandprior-not-generated`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.13) | MUST NOT | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.2.14:related-default-start`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.14) | MUST | n/a: The server never evaluates an alarm trigger. The alarms it writes carry TRIGGER without RELATED, so START applies by default (see RFC5545:3.8.6.3:trigger-default-duration-start); foreign alarms are kept verbatim. |  |
| [`RFC5545:3.2.16:role-default-req-participant`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.16) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.17:rsvp-default-false`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.17) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.18:sent-by-quoted-mailto`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.18) | MUST | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.19:tzid-required-for-local-datetime`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.19) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.2.19:exdate-tzid-matches-instance`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.19) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.2.19:vtimezone-per-tzid`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.19) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.2.19:tzid-not-on-date-or-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.19) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.19:tzid-absent-means-floating`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.19) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.2.19:tzid-solidus-global-id`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.19) | MAY | required | `src/conformance/expansion.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC5545:3.2.19:missing-vtimezone-inconsistent`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.19) | policy | required | `src/conformance/expansion.test.ts`, `src/conformance/timezone.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC5545:3.2.20:value-single-type`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.20) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2.20:value-param-required-when-overridden`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.20) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3:alternate-type-explicit-value`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.1:binary-encoding-base64`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.1) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.2:boolean-case-insensitive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.2) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.3:cal-address-mailto`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.3) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.4:date-format-yyyymmdd`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.4) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.5:no-utc-offset-form`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.5:form1-floating`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.3.5:floating-fixed-to-current-zone`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | SHOULD | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.5:fixed-time-needs-utc-or-tzid`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.5:form2-utc-z-suffix`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.5:utc-datetime-no-tzid`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST NOT | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.5:fold-first-occurrence`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.5:gap-offset-before-gap`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.5:leap-second-60`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.5:leap-second-as-59`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) | SHOULD | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.6:duration-no-year-month`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.6) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.6:duration-week-form-alone`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.6) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.6:no-leap-seconds-in-duration`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.6) | MUST NOT | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.6:duration-component-add-order`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.6) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.6:nominal-day-dst`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.6) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.8:integer-range`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.8) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.3.8:integer-unsigned-positive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.8) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.3.9:period-start-before-end`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.9) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.9:period-start-positive-duration`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.9) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:freq-required`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:rule-parts-at-most-once`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:freq-first-accept-any-order`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:until-same-type-as-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:until-floating-for-local-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:until-utc-for-utc-or-tzid-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:until-utc-in-vtimezone-observance`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts`, `src/conformance/timezone.test.ts` |
| [`RFC5545:3.3.10:until-inclusive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:until-datetime-in-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:count-and-until-exclusive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:count-bounds-occurrences`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:dtstart-counts-first`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:interval-positive-integer`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:wkst-significance`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:wkst-default-monday`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:bytime-not-with-date-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:bytime-on-date-ignored`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:byday-numeric-only-monthly-yearly`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:byday-numeric-not-yearly-byweekno`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:bymonthday-not-weekly`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:byyearday-not-daily-weekly-monthly`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:byweekno-only-yearly`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:bysetpos-needs-other-byxxx`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:invalid-dates-ignored-not-counted`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:rule-gap-time-like-explicit-datetime`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | policy | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:byxxx-evaluation-order`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:bymonthday-range`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:byyearday-range`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:byweekno-range`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:bymonth-range`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:bysecond-range-0-60`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:na-means-must-not-use`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.10:table-bymonth`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:table-byweekno`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:table-byyearday`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:table-bymonthday`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:table-byday-notes`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:limit-vs-expand-limit`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:limit-vs-expand-expand`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.10:missing-parts-from-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.11:text-newline-escape`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.11:text-backslash-escape`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.11:text-comma-escape`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.11:text-semicolon-escape`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.11:text-colon-not-escaped`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST NOT | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.12:time-hour-range`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.12) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.3.12:no-fractional-seconds`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.12) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.12:no-utc-offset-time`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.12) | MUST NOT | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.3.13:uri-generic-syntax`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.13) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.3.13:uri-param-quoted`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.13) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.14:utc-offset-plus-for-positive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.14) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/timezone.test.ts` |
| [`RFC5545:3.3.14:utc-offset-minus-for-negative`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.14) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/timezone.test.ts` |
| [`RFC5545:3.3.14:utc-offset-minus-zero-invalid`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.14) | MUST NOT | required | `src/conformance/generation.test.ts`, `src/conformance/timezone.test.ts` |
| [`RFC5545:3.3.14:utc-offset-seconds-not-60`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.14) | MUST NOT | required | `src/conformance/timezone.test.ts` |
| [`RFC5545:3.4:object-begin-end-delimiters`](https://www.rfc-editor.org/rfc/rfc5545#section-3.4) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.4:stream-multiple-objects`](https://www.rfc-editor.org/rfc/rfc5545#section-3.4) | MAY | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.5:no-property-ordering`](https://www.rfc-editor.org/rfc/rfc5545#section-3.5) | policy | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.6:prodid-version-required`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.6:at-least-one-component`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.6:ignore-unknown-components`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6) | MUST | required | `src/conformance/syntax.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC5545:3.6:do-not-silently-drop-components`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6) | SHOULD NOT | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.7:calprops-before-components`](https://www.rfc-editor.org/rfc/rfc5545#section-3.7) | SHOULD | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.7.1:calscale-default-gregorian`](https://www.rfc-editor.org/rfc/rfc5545#section-3.7.1) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.7.2:method-absent-no-scheduling`](https://www.rfc-editor.org/rfc/rfc5545#section-3.7.2) | MUST NOT | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.7.3:prodid-once`](https://www.rfc-editor.org/rfc/rfc5545#section-3.7.3) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.7.4:version-once`](https://www.rfc-editor.org/rfc/rfc5545#section-3.7.4) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.7.4:version-2-0`](https://www.rfc-editor.org/rfc/rfc5545#section-3.7.4) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.4.7:vevent-uid-required`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.7) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC5545:3.8.7.2:vevent-dtstamp-required`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.2) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.2.4:dtstart-required-without-method`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.4) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.2.4:dtstart-required-for-rrule`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.4) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.2.4:dtstart-default-datetime`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.4) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.6.1:dtend-xor-duration`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST NOT | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.1:optional-props-at-most-once`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST NOT | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.6.1:repeatable-props`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MAY | required | `src/conformance/reads.test.ts` |
| [`RFC5545:3.6.1:rrule-should-not-repeat`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | SHOULD NOT | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.5.3:multiple-rrule-undefined`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | SHOULD NOT | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.6.1:date-dtend-must-be-date`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.1:dtend-non-inclusive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.6.1:date-no-end-one-day`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST | required | `src/conformance/reads.test.ts` |
| [`RFC5545:3.6.1:datetime-no-end-zero-length`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST | required | `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.2.2:dtend-same-type-and-later`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.2) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.2.2:dtend-local-iff-dtstart-local`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.2) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.2.5:duration-positive-only`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.5) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.2.5:duration-date-dtstart-day-week`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.5) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.1.3:class-default-public`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.1.3) | MUST | required | `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.1.3:class-unknown-private`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.1.3) | MUST | required | `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.1.11:status-vevent-values`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.1.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.1.11:status-at-most-once`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.1.11) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.8.2.7:transp-default-opaque`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.7) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.7.2:dtstamp-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.2) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.7.1:created-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.1) | MUST | n/a: The server neither writes nor reads CREATED (new events carry DTSTAMP only); an existing CREATED line is left untouched by edits. |  |
| [`RFC5545:3.8.7.3:last-modified-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.3) | MUST | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.7.4:sequence-initial-zero`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.4) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.7.4:sequence-increment-on-revision`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.4) | MUST | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.7.4:sequence-per-instance`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.4) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.4.7:uid-globally-unique`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.7) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.4.7:uid-255-octets-no-utf8-truncation`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.7) | MUST | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.4.1:attendee-not-when-publishing`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.1) | MUST NOT | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.4.1:attendee-params-not-in-valarm`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.1) | MUST NOT | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.4.1:attendee-allowed-in-email-valarm`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.1) | MAY | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.8.4.1:delegatee-inherits-rsvp-role`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.1) | MUST | n/a: mcp-khal has no delegation workflow (respond_to_event only changes PARTSTAT of the user's own ATTENDEE line). |  |
| [`RFC5545:3.8.4.3:organizer-params-preserved`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.3) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.6.6:valarm-action-trigger-required`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.6:valarm-audio-attach`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MAY | n/a: We never write AUDIO alarms (only ACTION:DISPLAY) and do not validate the content of a foreign VALARM; its lines, ATTACH included, are preserved verbatim (see RFC5545:3.8.6.1:ignore-unknown-alarm-action). |  |
| [`RFC5545:3.6.6:valarm-display-description`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.6:valarm-email-requirements`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MUST | n/a: We never write EMAIL alarms (only ACTION:DISPLAY) and do not validate the content of a foreign VALARM; it is preserved verbatim. |  |
| [`RFC5545:3.6.6:valarm-repeat-needs-duration-and-repeat`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MUST | n/a: The server does not fire or schedule alarms and writes no repeating alarm; a foreign REPEAT/DURATION pair is preserved verbatim. |  |
| [`RFC5545:3.6.6:valarm-one-of-repeat-duration-no-repeat`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MUST | n/a: The server does not fire or schedule alarms, so repetition is never computed; the alarms it writes have neither REPEAT nor DURATION (see RFC5545:3.6.6:valarm-grammar-duration-repeat-pair), foreign ones are preserved verbatim. |  |
| [`RFC5545:3.6.6:valarm-grammar-duration-repeat-pair`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.6.2:repeat-count-additional`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.2) | MUST | n/a: The server neither reads nor writes REPEAT: it writes one non-repeating DISPLAY alarm and keeps foreign alarms verbatim. |  |
| [`RFC5545:3.8.6.1:ignore-unknown-alarm-action`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.1) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.8.6.1:action-once`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.1) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.6.3:trigger-default-duration-start`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.6.3:trigger-sign-before-after`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST | n/a: The server never interprets the sign of a trigger; it writes only negative durations (before the start, see RFC5545:3.8.6.3:trigger-default-duration-start) and keeps foreign alarms verbatim. |  |
| [`RFC5545:3.8.6.3:trigger-datetime-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST | n/a: The server never writes an absolute (DATE-TIME) trigger and does not parse foreign triggers; they are preserved verbatim. |  |
| [`RFC5545:3.8.6.3:related-invalid-with-datetime`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST NOT | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.6.3:date-event-trigger-midnight`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST | n/a: The server never computes when an alarm fires; for an all-day event it writes a TRIGGER duration relative to the start and leaves the interpretation to the calendar client. |  |
| [`RFC5545:3.8.6.3:relative-start-needs-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.6.3:relative-end-needs-dtend-or-duration`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST | n/a: The server never writes RELATED=END (its alarms are relative to the start, which every written event has) and does not validate foreign alarms, which are preserved verbatim. |  |
| [`RFC5545:3.8.6.3:absolute-trigger-recurring-once`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.6.3) | MUST | n/a: Alarm times are never expanded for a recurring event; the server writes only relative (duration) triggers and keeps foreign absolute ones verbatim. |  |
| [`RFC5545:3.6.6:valarm-only-in-vevent-vtodo-no-nesting`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.6:untrusted-alarms-policy`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6) | policy | deferred: The RFC only gives this as a note; mcp-khal reads only the user's own calendar directories, so no import path from untrusted sources exists. |  |
| [`RFC5545:3.6.5:vtimezone-tzid-and-observance-required`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/timezone.test.ts` |
| [`RFC5545:3.6.5:observance-required-props`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/timezone.test.ts` |
| [`RFC5545:3.6.5:observance-dtstart-local`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/timezone.test.ts` |
| [`RFC5545:3.8.2.4:observance-dtstart-no-tzid`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.4) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.5:vtimezone-covers-all-instances`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.5:vtimezone-unique-definition`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.6.5:offset-from-last-onset`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/timezone.test.ts` |
| [`RFC5545:3.6.5:observance-rrule-uses-tzoffsetfrom`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/timezone.test.ts` |
| [`RFC5545:3.6.5:observance-until-last-onset-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/timezone.test.ts` |
| [`RFC5545:3.6.5:observance-rdate-local-relative-tzoffsetfrom`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.5) | MUST | required | `src/conformance/timezone.test.ts` |
| [`RFC5545:3.8.3.3:tzoffset-sign-semantics`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.3.3) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5545:3.8.5.3:set-gathering-and-exclusion`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.1:exdate-excludes-dtstart-keep-original`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.1) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.5.1:exdate-precedence-over-rdate`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.1) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.5.3:duplicates-ignored`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.2:rdate-union-with-rrule`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.2) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.2:rdate-value-types`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.2) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.1:exdate-value-types`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.1) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.5.1:exdate-type-vs-dtstart-unspecified`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.1) | policy | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.3:dtstart-synchronized-with-rule`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | SHOULD | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.5.3:dtstart-unsynchronized-undefined`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | policy | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.3:dtstart-first-instance`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.3:dtstart-tzid-for-recurring-datetime`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | policy | required | `src/conformance/expansion.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.5.3:exact-duration-from-dtend`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.5.3:nominal-duration-from-duration`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-same-type-as-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-local-iff-dtstart-local`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-original-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-friday-to-thursday`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-date-is-calendar-date`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/editing.test.ts`, `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-replaces-instance-by-uid`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/expansion.test.ts`, `src/conformance/reads.test.ts` |
| [`RFC5545:3.8.4.4:thisandfuture-shifts-subsequent`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:thisandfuture-by-recurrence-id`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/expansion.test.ts` |
| [`RFC5545:3.8.4.4:end-series-by-truncating-rule`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MAY | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.8.4.4:override-with-rrule-unspecified`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | policy | n/a: RFC 5545 has no normative text forbidding or defining RRULE in an override; the earlier matrix claim had no RFC basis, so this is implementation policy only. |  |
| [`RFC5545:3.8.4.4:orphan-override-kept`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | policy | n/a: RFC 5545 has no normative text on overrides that match no instance; this is implementation policy to avoid data loss, not an RFC requirement. |  |

## scheduling-storage.json

| Id | Level | Status | Tests |
|---|---|---|---|
| [`RFC5546:2.1.4:organizer-revises-sequence`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.4) | policy | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:2.1.4:increment-on-trigger-properties`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.4) | MUST | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:2.1.4:increment-other-changes`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.4) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:2.1.4:no-increment-for-reply`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.4) | MUST NOT | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:2.1.4:increment-add-cancel`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.4) | MUST | n/a: We do not send iTIP messages (ADD, CANCEL); the stored-object consequence is covered by the RRULE trigger row. |  |
| [`RFC5546:2.1.5:primary-key-uid-recurrence-id`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.5) | SHOULD | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC5546:2.1.5:highest-sequence-obsoletes`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.5) | SHOULD | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:2.1.5:dtstamp-tiebreaker`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.5) | SHOULD | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:2.1.5:persist-key-properties`](https://www.rfc-editor.org/rfc/rfc5546#section-2.1.5) | SHOULD | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:3.1.1:version-2.0`](https://www.rfc-editor.org/rfc/rfc5546#section-3.1.1) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5546:3.2.1:publish-organizer-present`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.1) | MUST | n/a: Describes PUBLISH messages, which we never send; it only shows that ORGANIZER without ATTENDEE is a legal shape. |  |
| [`RFC5546:3.2.1:publish-attendee-absent`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.1) | MUST NOT | n/a: PUBLISH-message rule; we send no iTIP. The stored-object behaviour is POLICY:organizer-without-attendee-valid. |  |
| [`RFC5546:3.2.2.4:changing-organizer`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.2.4) | SHOULD | n/a: Requires sending a REQUEST to attendees, which we cannot do; handled by policy refusal. |  |
| [`RFC5546:3.2.2.7:recipient-replies-to-rsvp`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.2.7) | SHOULD | n/a: REPLY emission is out of scope: we do not send iTIP. |  |
| [`RFC5546:3.2.3:reply-optional-properties-unchanged`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.3) | MUST NOT | n/a: REPLY emission is out of scope; the stored-edit equivalent is the policy row. |  |
| [`RFC5546:3.2.3:reply-attendee-is-replier`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.3) | MUST | n/a: REPLY emission is out of scope; the stored-edit equivalent is POLICY:respond-local-partstat-only. |  |
| [`RFC5546:3.2.3:reply-recurrence-id-only-for-instance`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.3) | MUST NOT | n/a: REPLY emission is out of scope; the quote text is wrapped by table pipes in the source. |  |
| [`RFC5546:3.2.3:reply-sequence-nonzero`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.3) | MUST | n/a: REPLY emission is out of scope. |  |
| [`RFC5546:3.2.3:reply-comment`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.3) | MAY | n/a: A COMMENT only exists to reach the organizer inside a REPLY we do not send. |  |
| [`RFC5546:3.2.3:party-crasher`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.3) | MAY | n/a: Describes how an organizer treats unknown repliers; we are the replier, not the organizer. |  |
| [`RFC5546:3.2.5:cancel-whole-series-no-recurrence-id`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.5) | MUST NOT | n/a: CANCEL emission is out of scope: we do not send iTIP. |  |
| [`RFC5546:3.2.5:cancel-this-and-future-range`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.5) | MUST | n/a: CANCEL emission is out of scope; we truncate the stored RRULE instead. |  |
| [`RFC5546:3.2.5:cancel-increments-sequence`](https://www.rfc-editor.org/rfc/rfc5546#section-3.2.5) | MUST | n/a: Applies to CANCEL messages; the stored-edit effect is covered by RFC5546:2.1.4:increment-on-trigger-properties. |  |
| [`RFC5546:3.7.1:per-instance-partstat`](https://www.rfc-editor.org/rfc/rfc5546#section-3.7.1) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:3.7.1:no-per-instance-needed`](https://www.rfc-editor.org/rfc/rfc5546#section-3.7.1) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:3.7.1:recurrence-id-on-renegotiation`](https://www.rfc-editor.org/rfc/rfc5546#section-3.7.1) | policy | required | `src/conformance/editing.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5546:3.7.2:own-attendee-not-found`](https://www.rfc-editor.org/rfc/rfc5546#section-3.7.2) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:3.7.3:save-iana-tokens`](https://www.rfc-editor.org/rfc/rfc5546#section-3.7.3) | SHOULD | required | `src/conformance/scheduling.test.ts` |
| [`RFC5546:3.7.3:save-x-names`](https://www.rfc-editor.org/rfc/rfc5546#section-3.7.3) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.4.1:attendee-in-group-scheduled`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.1) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.4.3:organizer-in-group-scheduled`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.3) | MUST | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.4.3:organizer-not-for-single-user`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.3) | MUST NOT | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.2.12:partstat-allowed-values`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.12) | MUST | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.2.12:partstat-default`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.12) | policy | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.2.12:partstat-unknown-token`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2.12) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-same-value-type`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.8.4.4:recurrence-id-floating-iff`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MUST | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.8.4.4:range-instances-by-recurrence-id`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | policy | deferred: Goes with deferred RANGE=THISANDFUTURE expansion. |  |
| [`RFC5545:3.8.4.4:truncate-with-until`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4) | MAY | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.3.10:until-same-value-type`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.3.10:until-floating-dtstart`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.3.10:until-utc-for-utc-or-tzid`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.3.10:until-datetime-is-utc`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.3.10:until-count-exclusive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | MUST NOT | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.3.10:rdate-after-until`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10) | policy | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.3.11:text-backslash`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.11:text-comma`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.11:text-semicolon`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.3.11:text-newline`](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/reads.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2:param-values-quoted-when-separators`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2:param-values-no-dquote`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2) | MUST NOT | required | `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:crlf-line-breaks`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | policy | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:fold-at-75-octets`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | SHOULD NOT | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.1:no-split-utf8`](https://www.rfc-editor.org/rfc/rfc5545#section-3.1) | policy | required | `src/conformance/generation.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.6:no-silent-drop`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6) | SHOULD NOT | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC5545:3.2:ignore-unknown-params`](https://www.rfc-editor.org/rfc/rfc5545#section-3.2) | MUST | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC5545:3.6.1:dtstart-required-without-method`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.1:dtend-duration-exclusive`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST NOT | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.6.1:date-dtstart-date-dtend`](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1) | MUST | required | `src/conformance/editing.test.ts` |
| [`RFC5545:3.8.7.2:dtstamp-required`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.2) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.7.2:dtstamp-equals-last-modified-without-method`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.2) | policy | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.7.4:sequence-created-zero`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.4) | policy | required | `src/conformance/editing.test.ts`, `src/conformance/generation.test.ts` |
| [`RFC5545:3.8.7.4:sequence-incremented-by-organizer`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.4) | policy | required | `src/conformance/scheduling.test.ts` |
| [`RFC5545:3.8.7.4:per-instance-sequence`](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.4) | MAY | required | `src/conformance/scheduling.test.ts` |
| [`RFC6868:3:caret-escape-scope`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:3:encode-line-break`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:3:encode-caret`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:3:encode-dquote`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:3:decode-line-break`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:3:decode-caret`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:3:decode-dquote`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:3:unknown-sequence-kept`](https://www.rfc-editor.org/rfc/rfc6868#section-3) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6868:1:not-backslash-escaping`](https://www.rfc-editor.org/rfc/rfc6868#section-1) | MUST NOT | required | `src/conformance/syntax.test.ts` |
| [`RFC4791:4.1:one-component-type`](https://www.rfc-editor.org/rfc/rfc4791#section-4.1) | MUST NOT | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| [`RFC4791:4.1:vtimezone-per-tzid`](https://www.rfc-editor.org/rfc/rfc4791#section-4.1) | MUST | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC4791:4.1:no-method`](https://www.rfc-editor.org/rfc/rfc4791#section-4.1) | MUST NOT | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| [`RFC4791:4.1:uid-unique-in-collection`](https://www.rfc-editor.org/rfc/rfc4791#section-4.1) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC4791:4.1:different-uid-separate-resource`](https://www.rfc-editor.org/rfc/rfc4791#section-4.1) | MUST | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| [`RFC4791:4.1:same-uid-same-resource`](https://www.rfc-editor.org/rfc/rfc4791#section-4.1) | MUST | required | `src/conformance/scheduling.test.ts` |
| [`RFC4791:4.1:overrides-without-master`](https://www.rfc-editor.org/rfc/rfc4791#section-4.1) | MAY | required | `src/conformance/reads.test.ts` |
| [`RFC4791:3.2:recurrence-single-resource`](https://www.rfc-editor.org/rfc/rfc4791#section-3.2) | policy | required | `src/conformance/storage.test.ts` |
| [`RFC4791:5.3.2:url-arbitrary`](https://www.rfc-editor.org/rfc/rfc4791#section-5.3.2) | MAY | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| [`RFC4791:5.3.2:ics-suffix`](https://www.rfc-editor.org/rfc/rfc4791#section-5.3.2) | MAY | required | `src/conformance/generation.test.ts` |
| [`RFC4791:5.3.2:create-only-if-absent`](https://www.rfc-editor.org/rfc/rfc4791#section-5.3.2) | SHOULD | required | `src/conformance/generation.test.ts`, `src/conformance/storage.test.ts` |
| [`RFC4791:5.3.2.1:no-uid-change-on-overwrite`](https://www.rfc-editor.org/rfc/rfc4791#section-5.3.2.1) | MUST NOT | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| [`RFC7986:3:value-param-for-new-properties`](https://www.rfc-editor.org/rfc/rfc7986#section-3) | SHOULD | n/a: The server writes none of the properties RFC 7986 adds (COLOR, IMAGE, CONFERENCE, NAME, ...); existing ones are preserved verbatim, VALUE parameters included. |  |
| [`RFC7986:5.1:name-vcalendar-level`](https://www.rfc-editor.org/rfc/rfc7986#section-5.1) | MAY | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC7986:5.1:name-one-per-language`](https://www.rfc-editor.org/rfc/rfc7986#section-5.1) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC7986:5.3:uid-no-identifying-data`](https://www.rfc-editor.org/rfc/rfc7986#section-5.3) | MUST NOT | required | `src/conformance/generation.test.ts` |
| [`RFC7986:5.3:uid-uuid-recommended`](https://www.rfc-editor.org/rfc/rfc7986#section-5.3) | SHOULD | deferred: The UID is a random UUID v4 (randomUUID at the process edge) followed by the fixed suffix @mcp-khal, which split-off series also use; the value is therefore not a bare UUID. Dropping the suffix is a separate decision. |  |
| [`RFC7986:5.3:uid-opaque-length`](https://www.rfc-editor.org/rfc/rfc7986#section-5.3) | MUST | required | `src/conformance/generation.test.ts` |
| [`RFC7986:5.9:color-once`](https://www.rfc-editor.org/rfc/rfc7986#section-5.9) | MAY | n/a: No tool sets a colour: the server never writes COLOR and leaves an existing COLOR line untouched. |  |
| [`RFC7986:5.9:color-css3-name`](https://www.rfc-editor.org/rfc/rfc7986#section-5.9) | MUST | n/a: The server never generates COLOR and does not interpret colour names, so there is no value to validate; an existing COLOR is preserved verbatim. |  |
| [`RFC7986:5.9:color-clients-may-use`](https://www.rfc-editor.org/rfc/rfc7986#section-5.9) | MAY | required | `src/conformance/alarms-misc.test.ts` |
| [`RFC7986:5.10:image-media-type`](https://www.rfc-editor.org/rfc/rfc7986#section-5.10) | MUST | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC7986:5.10:image-value-encoding`](https://www.rfc-editor.org/rfc/rfc7986#section-5.10) | MUST | deferred: We do not create IMAGE properties; the rule matters only if image support is added. |  |
| [`RFC7986:5.10:image-fmttype-recommended`](https://www.rfc-editor.org/rfc/rfc7986#section-5.10) | SHOULD | deferred: We do not create IMAGE properties; existing ones are preserved only. |  |
| [`RFC7986:6.1:image-display-default`](https://www.rfc-editor.org/rfc/rfc7986#section-6.1) | MUST | deferred: We do not render images; only preservation matters. |  |
| [`RFC7986:5.11:conference-vevent-todo-only`](https://www.rfc-editor.org/rfc/rfc7986#section-5.11) | MAY | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| [`RFC7986:5.11:conference-value-uri-required`](https://www.rfc-editor.org/rfc/rfc7986#section-5.11) | MUST | required | `src/conformance/syntax.test.ts` |
| [`RFC6047:2.2.1:only-organizer-modifies`](https://www.rfc-editor.org/rfc/rfc6047#section-2.2.1) | policy | n/a: Authorization rule for iMIP messages; we process no messages. See POLICY:non-organizer-edit-is-local. | `src/conformance/scheduling.test.ts` |
| [`RFC6047:2.2.1:only-respondent-sets-status`](https://www.rfc-editor.org/rfc/rfc6047#section-2.2.1) | policy | required | `src/conformance/scheduling.test.ts` |
| [`RFC6047:2.3:mailto-addresses`](https://www.rfc-editor.org/rfc/rfc6047#section-2.3) | MUST | required | `src/conformance/generation.test.ts`, `src/conformance/scheduling.test.ts` |
| [`RFC6047:2.4:method-parameter-matches`](https://www.rfc-editor.org/rfc/rfc6047#section-2.4) | MUST | n/a: iMIP transport rule; we never build iMIP messages. |  |
| [`VDIR:one-item-per-file`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MUST | required | `src/conformance/generation.test.ts` |
| [`VDIR:recurrence-exceptions-in-same-file`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MAY | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| [`VDIR:uid-should-be-present`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | SHOULD | required | `src/conformance/generation.test.ts` |
| [`VDIR:uid-values-equal`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MUST NOT | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| [`VDIR:filename-similar-to-uid`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | SHOULD | required | `src/conformance/generation.test.ts`, `src/conformance/storage.test.ts` |
| [`VDIR:filename-no-requirement`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MAY | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| [`VDIR:filename-metadata-not-preserved`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MUST NOT | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| [`VDIR:keep-original-filename`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | SHOULD | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| [`VDIR:atomic-write`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | SHOULD | required | `src/conformance/storage.test.ts` |
| [`VDIR:tmp-files-allowed`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MAY | required | `src/conformance/storage.test.ts` |
| [`VDIR:ignore-tmp-and-no-extension`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MUST NOT | required | `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| [`VDIR:ics-extension`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | SHOULD | required | `src/conformance/generation.test.ts`, `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| [`VDIR:metadata-files-no-extension`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | policy | required | `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| [`VDIR:color-format`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | MUST | deferred: The server only reads the colour for display if at all; no tool writes the color file. |  |
| [`VDIR:collection-contains-only-items`](https://vdirsyncer.pimutils.org/en/stable/vdir.html) | policy | required | `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| `POLICY:strip-method-on-write` | policy | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| `POLICY:tolerate-method-on-read` | policy | required | `src/conformance/storage.test.ts`, `src/conformance/vendors.test.ts` |
| `POLICY:respond-local-partstat-only` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:respond-instance-override` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:respond-requires-organizer` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:reject-respond-when-not-attendee` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:respond-clears-rsvp` | policy | deferred: No RFC requirement; RSVP only asks the organizer's client for a reply, which we do not send. Revisit when a user-visible need appears. |  |
| `POLICY:no-itip-emission` | policy | required | `src/conformance/alarms-misc.test.ts` |
| `POLICY:refuse-organizer-change` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:organizer-without-attendee-valid` | policy | required | `src/conformance/reads.test.ts`, `src/conformance/scheduling.test.ts` |
| `POLICY:sequence-organizer-bump` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:non-organizer-edit-is-local` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:update-refreshes-dtstamp-last-modified` | policy | required | `src/conformance/scheduling.test.ts` |
| `POLICY:end-series-truncate-rrule` | policy | required | `src/conformance/editing.test.ts` |
| `POLICY:preserve-unknown-and-raw` | policy | required | `src/conformance/scheduling.test.ts`, `src/conformance/syntax.test.ts` |
| `POLICY:match-override-by-recurrence-id-value` | policy | required | `src/conformance/editing.test.ts` |
| `POLICY:new-event-filename-and-uid` | policy | required | `src/conformance/generation.test.ts`, `src/conformance/storage.test.ts` |
| `POLICY:refuse-multi-uid-or-multi-type-files` | policy | required | `src/conformance/scheduling.test.ts`, `src/conformance/storage.test.ts` |
| `POLICY:vtimezone-generated-per-tzid` | policy | required | `src/conformance/generation.test.ts` |
