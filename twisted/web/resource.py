class Resource:
    isLeaf = False

    def __init__(self):
        pass

    def getChild(self, path, request):
        return self

    def render(self, request):
        return b""
