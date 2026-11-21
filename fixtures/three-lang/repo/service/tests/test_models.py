from service.models import make_user


def test_make_user():
    assert make_user("a").name == "a"
