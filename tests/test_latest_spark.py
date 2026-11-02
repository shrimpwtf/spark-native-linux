from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packaging'))

import latest_spark  # noqa: E402

URL = 'https://downloads.sparkmailapp.com/Spark3/win/dist/{}/Spark.exe'


class LatestSparkTests(unittest.TestCase):
    def test_returns_the_newest_entry_and_its_installer(self):
        text = (f'Version 3.32.1.141358\n\nnotes\n\n{URL.format("3.32.1.141358")}\n\n'
                f'Version 3.32.0.141284\n\nnotes\n\n{URL.format("3.32.0.141284")}\n')
        self.assertEqual(latest_spark.newest(text),
                         ('3.32.1.141358', URL.format('3.32.1.141358')))

    def test_rejects_a_newest_entry_without_a_full_version(self):
        text = f'Version 3.33.0\n\nnotes\n\nVersion 3.32.1.141358\n\n{URL.format("3.32.1.141358")}\n'
        with self.assertRaises(ValueError):
            latest_spark.newest(text)

    def test_does_not_borrow_an_older_entrys_link(self):
        text = f'Version 3.33.0.150000\n\nnotes only\n\nVersion 3.32.1.141358\n\n{URL.format("3.32.1.141358")}\n'
        with self.assertRaises(ValueError):
            latest_spark.newest(text)

    def test_rejects_a_link_for_a_different_version(self):
        text = f'Version 3.33.0.150000\n\n{URL.format("3.32.1.141358")}\n'
        with self.assertRaises(ValueError):
            latest_spark.newest(text)

    def test_rejects_a_page_without_versions(self):
        with self.assertRaises(ValueError):
            latest_spark.newest('<html>maintenance</html>')


if __name__ == '__main__':
    unittest.main()
