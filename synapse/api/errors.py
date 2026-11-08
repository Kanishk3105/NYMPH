class Codes:
    TOO_LARGE = 413
    INVALID_PARAM = 400
    UNKNOWN = 500
    NOT_FOUND = 404
    FORBIDDEN = 403
    CONFLICT = 409


class SynapseError(RuntimeError):
    def __init__(self, code: int, msg: str, errcode: str | None = None) -> None:
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.errcode = errcode
