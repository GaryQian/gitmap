class User:
    def __init__(self, name: str):
        self.name = name

    @staticmethod
    def describe(user: "User") -> str:
        return "user:" + user.name


def make_user(name: str) -> User:
    return User(name)
