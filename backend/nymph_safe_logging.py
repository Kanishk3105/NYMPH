import json
import logging
import time


class SafeJsonFormatter(logging.Formatter):
    """Emit operational metadata only; never serialize log message or exception text."""

    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(
            {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
                "level": record.levelname,
                "logger": record.name,
                "exception": record.exc_info is not None,
            },
            separators=(",", ":"),
        )
