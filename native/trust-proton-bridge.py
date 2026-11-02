#!/usr/bin/env python3
"""Trust Proton Mail Bridge's local certificate inside native mode's Wine prefix.

Bridge uses a self-signed certificate, and Spark's final account check rejects it.
This adds it to one prefix's trusted roots and changes nothing on the host or in
the Wine mode's prefix.
"""
import getpass
import hashlib
import os
import ssl
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT_HASH_PROP_ID = 3
CERT_CERT_PROP_ID = 32
ENCODING = 1  # X509_ASN_ENCODING


def bridge_certificate():
    """Read the certificate Bridge serves on the loopback SMTP port."""
    result = subprocess.run(
        ['openssl', 's_client', '-connect', '127.0.0.1:1025', '-starttls', 'smtp'],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
    begin, end = '-----BEGIN CERTIFICATE-----', '-----END CERTIFICATE-----'
    if begin not in result.stdout or end not in result.stdout:
        sys.exit('error: no certificate from 127.0.0.1:1025. Is Bridge running?')
    pem = result.stdout[result.stdout.index(begin):result.stdout.index(end) + len(end)] + '\n'
    subject = subprocess.run(
        ['openssl', 'x509', '-noout', '-subject', '-issuer', '-nameopt', 'RFC2253'],
        input=pem, capture_output=True, text=True, check=True).stdout
    for line in subject.splitlines():
        if 'O=Proton AG' not in line or 'CN=127.0.0.1' not in line:
            sys.exit('error: the server on 127.0.0.1:1025 is not Proton Mail Bridge')
    return ssl.PEM_cert_to_DER_cert(pem)


def registry_file(der):
    """Build a .reg entry in the serialized form Windows keeps certificates in."""
    thumbprint = hashlib.sha1(der).digest()
    blob = b''
    for prop_id, value in ((CERT_HASH_PROP_ID, thumbprint), (CERT_CERT_PROP_ID, der)):
        blob += struct.pack('<III', prop_id, ENCODING, len(value)) + value
    return (
        'Windows Registry Editor Version 5.00\r\n\r\n'
        '[HKEY_CURRENT_USER\\Software\\Microsoft\\SystemCertificates\\Root\\Certificates\\'
        f'{thumbprint.hex().upper()}]\r\n'
        f'"Blob"=hex:{",".join(f"{byte:02x}" for byte in blob)}\r\n'
    ), thumbprint.hex().upper()


def main():
    state = os.environ.get('SPARK_NATIVE_STATE') or os.path.join(ROOT, 'native-state')
    prefix = os.path.join(state, 'prefix')
    if os.path.realpath(prefix) == os.path.realpath(os.path.join(ROOT, 'prefix')):
        sys.exit('error: this script does not change the Wine mode prefix')
    profile = os.path.join(prefix, 'drive_c', 'users', getpass.getuser())
    if not os.path.isdir(profile):
        sys.exit(f'error: no prefix at {prefix}. Start native mode once first.')
    content, thumbprint = registry_file(bridge_certificate())
    environment = dict(
        os.environ, SPARK_ROOT=ROOT, SPARK_STATE=state, SPARK_PREFIX=prefix,
        SPARK_NOTIFY='0', SPARK_CLOSE_TRAY='0', SPARK_IMAGE_BRIDGE='0',
        SPARK_EXE='C:\\windows\\system32\\reg.exe')
    launcher = os.path.join(ROOT, 'run-spark.sh')
    with tempfile.NamedTemporaryFile('w', suffix='.reg', dir=profile, newline='') as handle:
        handle.write(content)
        handle.flush()
        windows_path = 'C:\\users\\' + getpass.getuser() + '\\' + os.path.basename(handle.name)
        subprocess.run([launcher, 'import', windows_path], env=environment, check=True)
    subprocess.run(
        [launcher, 'query',
         'HKCU\\Software\\Microsoft\\SystemCertificates\\Root\\Certificates\\' + thumbprint],
        env=environment, check=True, stdout=subprocess.DEVNULL)
    print(f'Trusted Proton Mail Bridge certificate {thumbprint} in {prefix}')


if __name__ == '__main__':
    main()
