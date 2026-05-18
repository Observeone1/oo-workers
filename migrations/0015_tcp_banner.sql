-- TCP banner/probe-read: optionally send a payload on connect and assert
-- on the server's response banner. All columns nullable with no default,
-- so existing tcp monitors keep pure connect-latency behaviour unchanged.

ALTER TABLE tcp_monitors  ADD COLUMN payload_hex   TEXT;
ALTER TABLE tcp_monitors  ADD COLUMN expect_banner TEXT;
ALTER TABLE tcp_executions ADD COLUMN banner       TEXT;
