#!/usr/bin/env python3
"""Print the newest Spark Windows release from Readdle's changelog.

Output: "VERSION URL". Exits nonzero when the page no longer has the layout
this script relies on, so a bad parse never publishes an older release.
"""
import re
import sys
import urllib.request

CHANGELOG = 'https://sparkmailapp.com/spark3/win/changelog'
INSTALLER = 'https://downloads.sparkmailapp.com/Spark3/win/dist/{}/Spark.exe'
HEADING = re.compile(r'Version\s+(\d+(?:\.\d+)*)')
FULL_VERSION = re.compile(r'\d+\.\d+\.\d+\.\d+$')
LINK = re.compile(r'https://downloads\.sparkmailapp\.com/Spark3/win/dist/(\d+\.\d+\.\d+\.\d+)/Spark\.exe')
MINIMUM_INSTALLER_BYTES = 100_000_000


def newest(text):
    heading = HEADING.search(text)
    if not heading:
        raise ValueError('no version heading found')
    version = heading.group(1)
    if not FULL_VERSION.match(version):
        raise ValueError(f'newest entry has an unexpected version format: {version}')
    following = HEADING.search(text, heading.end())
    section = text[heading.end():following.start() if following else len(text)]
    link = LINK.search(section)
    if not link:
        raise ValueError(f'newest entry {version} has no installer link')
    if link.group(1) != version:
        raise ValueError(f'newest entry {version} links to {link.group(1)}')
    return version, INSTALLER.format(version)


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'spark-native-linux-updater'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode('utf-8', 'replace')


def installer_size(url):
    request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'spark-native-linux-updater'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return int(response.headers.get('Content-Length', '0'))


def main():
    version, url = newest(fetch(CHANGELOG))
    size = installer_size(url)
    if size < MINIMUM_INSTALLER_BYTES:
        raise ValueError(f'installer for {version} is only {size} bytes')
    print(version, url)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
