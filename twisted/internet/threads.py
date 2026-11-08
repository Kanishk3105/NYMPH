import asyncio


async def deferToThread(func, *args, **kwargs):
    return func(*args, **kwargs)
