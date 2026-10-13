"""Native identity in Secret Service; disk holds only installation, pins and attempt timestamps.

Never unlock collections, fall back to plaintext, or replace a missing pinned key.
Secret Service does not isolate a key from other compromised processes of this UID.
"""
import fcntl
import hashlib
import math
import os
from pathlib import Path
import stat
import time
import uuid

from channel import jwk, public, encode, decode, require, identity, valid_uuid


def private_directory(directory):
    directory = Path(directory)
    require(directory.is_absolute() and all(not p.is_symlink() for p in (directory, *directory.parents)), "UNAVAILABLE")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = directory.lstat()
    require(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid()
            and not value.st_mode & 0o077, "UNAVAILABLE")
    return directory


def owned_file(fd, maximum):
    value = os.fstat(fd)
    require(stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid()
            and not value.st_mode & 0o077 and 0 <= value.st_size <= maximum, "UNAVAILABLE")


def read_private(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        owned_file(fd, maximum)
        data = os.read(fd, maximum + 1)
        require(len(data) <= maximum, "UNAVAILABLE")
        return data
    finally:
        os.close(fd)


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def installation_id(directory):
    marker = directory / "installation-id"
    try:
        data = read_private(marker, 36).decode("ascii")
        require(valid_uuid(data), "UNAVAILABLE")
        return data
    except FileNotFoundError:
        pass
    identifier = str(uuid.uuid4())
    temporary = directory / (".installation-id-" + str(uuid.uuid4()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, identifier.encode()) == 36, "UNAVAILABLE")
        os.fsync(fd)
        try:
            os.link(temporary, marker, follow_symlinks=False)
            sync_directory(directory)
            return identifier
        except FileExistsError:
            data = read_private(marker, 36).decode("ascii")
            require(valid_uuid(data), "UNAVAILABLE")
            return data
    finally:
        os.close(fd)
        temporary.unlink(missing_ok=True)


def load_identity(directory, owner):
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Secret

    require(isinstance(owner, dict) and set(owner) == {"serverId", "deviceId", "profileId"}
            and all(identity(item) for item in owner.values()), "INVALID_IDENTITY")
    directory = private_directory(directory)
    lock = os.open(directory / "identity.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        owned_file(lock, 0)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        installation = installation_id(directory)
        namespace = hashlib.sha256(encode(owner)).hexdigest()
        schema = Secret.Schema.new("app.joko.RemoteCredentials", Secret.SchemaFlags.NONE,
                                   {"installation": Secret.SchemaAttributeType.STRING,
                                    "owner": Secret.SchemaAttributeType.STRING})
        attrs = {"installation": installation, "owner": namespace}
        service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
        require(service is not None, "UNAVAILABLE")
        items = service.search_sync(schema, attrs, Secret.SearchFlags.ALL | Secret.SearchFlags.LOAD_SECRETS, None)
        require(len(items) <= 1, "UNAVAILABLE")
        marker = directory / (namespace + ".public-sha256")
        try:
            pinned = read_private(marker, 64).decode("ascii")
            require(len(pinned) == 64 and all(x in "0123456789abcdef" for x in pinned), "INVALID_IDENTITY")
        except FileNotFoundError:
            pinned = None
        if items:
            require(not items[0].get_locked(), "UNAVAILABLE")
            secret = items[0].get_secret()
            require(secret is not None, "UNAVAILABLE")
            key = jwk.JWK.from_json(secret.get_text())
            require(key.has_private and key.get("kty") == "EC" and key.get("crv") == "P-256", "UNAVAILABLE")
        else:
            require(pinned is None, "INVALID_IDENTITY")
            collection = Secret.Collection.for_alias_sync(service, "default", Secret.CollectionFlags.NONE, None)
            require(collection is not None and not collection.get_locked(), "UNAVAILABLE")
            key = jwk.JWK.generate(kty="EC", crv="P-256")
            require(Secret.password_store_sync(schema, attrs, "default", "Joko remote desktop identity",
                                              key.export_private(), None), "UNAVAILABLE")
        fingerprint = hashlib.sha256(encode(public(key))).hexdigest()
        if pinned is not None:
            require(pinned == fingerprint, "INVALID_IDENTITY")
        else:
            temporary = directory / (".identity-pin-" + str(uuid.uuid4()))
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                require(os.write(fd, fingerprint.encode()) == 64, "UNAVAILABLE")
                os.fsync(fd)
                os.link(temporary, marker, follow_symlinks=False)
                sync_directory(directory)
            finally:
                os.close(fd)
                temporary.unlink(missing_ok=True)
        return key
    finally:
        os.close(lock)


def admit_attempt(directory, now=None):
    """Five atomic nonsecret timestamps survive native helper replacement."""
    directory = private_directory(directory)
    now = time.time() if now is None else now
    require(type(now) in (float, int) and math.isfinite(now) and now > 0, "UNAVAILABLE")
    lock = os.open(directory / "credential-attempt-window.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        owned_file(lock, 0)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / "credential-attempt-window.json"
        try:
            values = decode(read_private(path, 1024))
            require(isinstance(values, list) and len(values) <= 5
                    and all(type(x) in (int, float) and math.isfinite(x) and 0 < x <= now for x in values)
                    and values == sorted(values), "UNAVAILABLE")
            values = [x for x in values if now - x < 60]
        except FileNotFoundError:
            values = []
        require(len(values) < 5, "UNAVAILABLE")
        values.append(now)
        data = encode(values)
        temporary = directory / (".credential-attempt-window-" + str(uuid.uuid4()))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            require(os.write(fd, data) == len(data), "UNAVAILABLE")
            os.fsync(fd)
            os.close(fd)
            fd = None
            os.replace(temporary, path)
            sync_directory(directory)
        finally:
            if fd is not None:
                os.close(fd)
            temporary.unlink(missing_ok=True)
    finally:
        os.close(lock)
