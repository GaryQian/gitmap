from .models import User


def connect(name: str):
    return {"name": name, "rows": []}


def save(conn, user: User) -> None:
    conn["rows"].append(user)
