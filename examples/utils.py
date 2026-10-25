# Example Python file for `codelens demo`.
import os

password = "hunter2-super-secret"


def load_config(path):
    try:
        return eval(open(path).read())
    except:
        pass


def get_user(cursor, name):
    cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")
    print("fetched", name)
    return cursor.fetchone()
