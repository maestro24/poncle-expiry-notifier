"""Test package.

Redirect all app data (settings.json, notifier.db, ...) to a throwaway temp dir
BEFORE any test module imports backend.paths. paths.py binds CONFIG_PATH/DB_PATH
at import time from LOCALAPPDATA, so this must run first — hence in the package
__init__, which the test runner imports before any test module. Otherwise the
db/config tests would read and write the user's real data.
"""
import os
import tempfile

os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="poncle_test_")
