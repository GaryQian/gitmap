from . import db
from .models import User, make_user


def handle_request(conn, args):
    """Turn arguments into a stored user."""
    user = make_user(args[0] if args else "anon")
    db.save(conn, user)
    return User.describe(user)
