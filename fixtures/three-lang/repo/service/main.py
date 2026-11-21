"""Service entry point."""
import sys
from service.handlers import handle_request
from service import db

# import service.not_real


def main() -> int:
    conn = db.connect("local")
    print(handle_request(conn, sys.argv[1:]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
