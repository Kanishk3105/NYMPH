import asyncio


class Deferred:
    def __init__(self, result=None, *, exception=None):
        self._result = result
        self._exception = exception

    def addCallback(self, callback, *args, **kwargs):
        return self

    def addErrback(self, callback, *args, **kwargs):
        return self

    def result(self):
        if self._exception is not None:
            raise self._exception
        return self._result


def ensureDeferred(awaitable):
    if asyncio.iscoroutine(awaitable):
        return awaitable
    if asyncio.isfuture(awaitable):
        return awaitable

    async def _runner():
        if callable(awaitable):
            return await awaitable()
        return awaitable

    return _runner()
