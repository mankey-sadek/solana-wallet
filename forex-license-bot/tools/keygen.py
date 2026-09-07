#!/usr/bin/env python3
"""Offline license-key generator for TimeGridEA (MQL4).

Key format:  <account>-<expiry:YYYYMMDD>-<signature:16 hex chars>
signature = HMAC-SHA256(secret, f"{account}|{expiry}")[:8 bytes] as hex

LICENSE_SECRET below must exactly match InpLicenseSecret compiled into
TimeGridEA.mq4 (Experts/TimeGridEA.mq4). Keep this script and the
secret private - anyone with both can mint valid keys for any account.
"""
import argparse
import hashlib
import hmac
from datetime import date, timedelta

LICENSE_SECRET = "REPLACE_WITH_YOUR_SECRET"  # must match the EA's InpLicenseSecret


def generate_key(account: int, expiry: date, secret: str = LICENSE_SECRET) -> str:
    expiry_str = expiry.strftime("%Y%m%d")
    payload = f"{account}|{expiry_str}".encode("ascii")
    mac = hmac.new(secret.encode("ascii"), payload, hashlib.sha256).hexdigest().upper()
    signature = mac[:16]
    return f"{account}-{expiry_str}-{signature}"


def verify_key(key: str, secret: str = LICENSE_SECRET) -> bool:
    try:
        account_str, expiry_str, signature = key.split("-")
        expected = generate_key(int(account_str), date(int(expiry_str[:4]), int(expiry_str[4:6]), int(expiry_str[6:8])), secret)
        return hmac.compare_digest(expected, key)
    except (ValueError, IndexError):
        return False


def main():
    parser = argparse.ArgumentParser(description="Generate or verify a TimeGridEA license key")
    sub = parser.add_subparsers(dest="cmd", required=True)

    gen = sub.add_parser("generate", help="Generate a new license key")
    gen.add_argument("account", type=int, help="MetaTrader account number")
    gen.add_argument("--days", type=int, default=365, help="Validity in days from today")
    gen.add_argument("--secret", default=LICENSE_SECRET, help="Override the license secret")

    ver = sub.add_parser("verify", help="Verify an existing license key")
    ver.add_argument("key", help="The license key to check")
    ver.add_argument("--secret", default=LICENSE_SECRET, help="Override the license secret")

    args = parser.parse_args()

    if args.cmd == "generate":
        expiry = date.today() + timedelta(days=args.days)
        print(generate_key(args.account, expiry, args.secret))
    elif args.cmd == "verify":
        print("VALID" if verify_key(args.key, args.secret) else "INVALID")


if __name__ == "__main__":
    main()
