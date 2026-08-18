#!/usr/bin/env python3
"""Validate and safely extract the standalone release archive.

Regular files and directories are materialized before any symbolic link. This
ordering is intentional: no archive payload can be written through a link that
was created by an earlier member.
"""

import gzip
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import stat
import sys
import tarfile
import tempfile
from typing import Dict, Iterable, List, Set, Tuple


MAX_MEMBER_COUNT = 250_000
MAX_COMPRESSED_BYTES = 512 * 1024 * 1024
MAX_TAR_STREAM_BYTES = 1024 * 1024 * 1024
MAX_EXPANDED_BYTES = 768 * 1024 * 1024
MAX_METADATA_RECORD_BYTES = 4096
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_SYMLINK_DEPTH = 4096
MAX_PATH_BYTES = 4095
MAX_PATH_COMPONENTS = 128
MAX_COMPONENT_BYTES = 255
MAX_EFFECTIVE_ENTRY_COUNT = 300_000
MIN_FREE_BYTES_AFTER_EXTRACTION = 768 * 1024 * 1024
MIN_FREE_INODES_AFTER_EXTRACTION = 50_000
TAR_BLOCK_BYTES = 512
METADATA_MEMBER_TYPES = (b"x", b"g", b"X", b"L", b"K")
REJECTED_EXTENSION_TYPES = (b"x", b"g", b"X", tarfile.GNUTYPE_SPARSE)


class ReleaseArchiveError(Exception):
    """The release archive violates the host extraction policy."""


class ArchiveMetrics:
    def __init__(
        self,
        compressed_bytes: int,
        tar_stream_bytes: int,
        expanded_bytes: int,
        member_count: int,
    ) -> None:
        self.compressed_bytes = compressed_bytes
        self.tar_stream_bytes = tar_stream_bytes
        self.expanded_bytes = expanded_bytes
        self.member_count = member_count


class PathTrieNode:
    __slots__ = ("children", "member")

    def __init__(self) -> None:
        self.children = {}
        self.member = None


def is_regular_member(member: tarfile.TarInfo) -> bool:
    return member.type in (tarfile.REGTYPE, tarfile.AREGTYPE)


def reject_control_characters(value: str) -> None:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ReleaseArchiveError("an archive path contains control characters")


def validate_path_budget(value: str, allow_parent_segments: bool = False) -> None:
    try:
        encoded = value.encode("utf-8", "surrogateescape")
    except UnicodeEncodeError:
        raise ReleaseArchiveError("an archive path is not valid filesystem text")
    if len(encoded) > MAX_PATH_BYTES:
        raise ReleaseArchiveError("an archive path exceeds the length limit")

    parts = value.split("/")
    if len(parts) > MAX_PATH_COMPONENTS:
        raise ReleaseArchiveError("an archive path has too many components")
    saw_non_parent_segment = False
    for part in parts:
        if not part or part == "." or (part == ".." and not allow_parent_segments):
            raise ReleaseArchiveError("an archive path is not canonical")
        if part == "..":
            if saw_non_parent_segment:
                raise ReleaseArchiveError(
                    "a symbolic link parent segment must precede its path"
                )
        else:
            saw_non_parent_segment = True
        if len(part.encode("utf-8", "surrogateescape")) > MAX_COMPONENT_BYTES:
            raise ReleaseArchiveError("an archive path component exceeds the length limit")


def canonical_member_name(raw_name: str) -> str:
    reject_control_characters(raw_name)
    if (
        not raw_name
        or raw_name.startswith(("/", "\\"))
        or "\\" in raw_name
        or ":" in raw_name
    ):
        raise ReleaseArchiveError("an archive member path is not relative POSIX syntax")

    name = raw_name[:-1] if raw_name.endswith("/") else raw_name
    validate_path_budget(name)
    parts = name.split("/")
    if not name or any(part in ("", ".", "..") for part in parts):
        raise ReleaseArchiveError("an archive member path is not canonical")

    canonical = str(PurePosixPath(*parts))
    if canonical != name or posixpath.isabs(canonical):
        raise ReleaseArchiveError("an archive member path changes after normalization")
    return canonical


def canonical_link_target(member_name: str, raw_target: str) -> str:
    reject_control_characters(raw_target)
    if (
        not raw_target
        or raw_target.startswith(("/", "\\"))
        or "\\" in raw_target
        or ":" in raw_target
    ):
        raise ReleaseArchiveError("a symbolic link target is not relative POSIX syntax")
    validate_path_budget(raw_target, allow_parent_segments=True)

    target = posixpath.normpath(
        posixpath.join(posixpath.dirname(member_name), raw_target)
    )
    if target in ("", ".", "..") or target.startswith("../") or posixpath.isabs(target):
        raise ReleaseArchiveError("a symbolic link target escapes the release root")
    reject_control_characters(target)
    validate_path_budget(target)
    return target


def parse_octal_tar_number(field: bytes) -> int:
    # The repository-created archive never needs GNU base-256 numeric fields.
    # Rejecting them keeps the streaming budget parser small and unambiguous.
    if field and field[0] & 0x80:
        raise ReleaseArchiveError("the archive uses a non-canonical numeric field")
    value = field.strip(b" \0")
    if not value:
        return 0
    if any(character < ord("0") or character > ord("7") for character in value):
        raise ReleaseArchiveError("the archive contains an invalid numeric field")
    return int(value, 8)


def discard_exact(stream, size: int) -> None:
    remaining = size
    while remaining:
        chunk = stream.read(min(1024 * 1024, remaining))
        if not chunk:
            raise ReleaseArchiveError("the compressed tar stream is truncated")
        remaining -= len(chunk)


def preflight_tar_stream(path: Path) -> int:
    """Bound gzip expansion and extension metadata before tarfile allocates it."""
    stream_bytes = 0
    metadata_bytes = 0
    raw_member_count = 0
    zero_blocks = 0

    with gzip.open(str(path), "rb") as stream:
        while True:
            header = stream.read(TAR_BLOCK_BYTES)
            if not header:
                break
            if len(header) != TAR_BLOCK_BYTES:
                raise ReleaseArchiveError("the tar stream has a partial header")
            stream_bytes += TAR_BLOCK_BYTES
            if stream_bytes > MAX_TAR_STREAM_BYTES:
                raise ReleaseArchiveError("the tar stream exceeds the expansion limit")

            if header == b"\0" * TAR_BLOCK_BYTES:
                zero_blocks += 1
                continue
            if zero_blocks:
                raise ReleaseArchiveError("the tar stream has data after its end marker")

            raw_member_count += 1
            if raw_member_count > MAX_MEMBER_COUNT * 2:
                raise ReleaseArchiveError("the tar stream contains too many raw headers")
            size = parse_octal_tar_number(header[124:136])
            padded_size = ((size + TAR_BLOCK_BYTES - 1) // TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
            if padded_size > MAX_TAR_STREAM_BYTES - stream_bytes:
                raise ReleaseArchiveError("the tar stream exceeds the expansion limit")

            member_type = header[156:157] or tarfile.AREGTYPE
            if member_type in METADATA_MEMBER_TYPES:
                if size > MAX_METADATA_RECORD_BYTES:
                    raise ReleaseArchiveError("an archive metadata record exceeds the limit")
                metadata_bytes += size
                if metadata_bytes > MAX_METADATA_BYTES:
                    raise ReleaseArchiveError("archive metadata exceeds the total limit")
            if member_type in REJECTED_EXTENSION_TYPES:
                raise ReleaseArchiveError("the archive uses an unsupported metadata extension")
            discard_exact(stream, padded_size)
            stream_bytes += padded_size

    if zero_blocks < 2:
        raise ReleaseArchiveError("the tar stream is missing its end marker")
    return stream_bytes


def validate_parent_types(
    members_by_name: Dict[str, tarfile.TarInfo],
) -> int:
    # A component trie avoids repeatedly copying every growing parent prefix.
    # This keeps validation linear in the total number of path components.
    root = PathTrieNode()
    effective_entry_count = 0
    for name, member in members_by_name.items():
        node = root
        for component in name.split("/"):
            child = node.children.get(component)
            if child is None:
                child = PathTrieNode()
                node.children[component] = child
                effective_entry_count += 1
                if effective_entry_count > MAX_EFFECTIVE_ENTRY_COUNT:
                    raise ReleaseArchiveError(
                        "the archive expands to too many filesystem entries"
                    )
            node = child
        node.member = member

    stack = [root]
    while stack:
        node = stack.pop()
        if node.children and node.member is not None and not node.member.isdir():
            raise ReleaseArchiveError("an archive member parent is not a directory")
        stack.extend(node.children.values())
    return effective_entry_count


def validate_symbolic_link_graph(
    existing_names: Set[str],
    link_targets: Dict[str, str],
) -> None:
    # Iterative three-state traversal gives O(number of links) validation and
    # avoids Python recursion limits on hostile chains.
    state: Dict[str, int] = {}
    resolved: Dict[str, str] = {}
    for start in link_targets:
        if state.get(start) == 2:
            continue
        current = start
        trail: List[str] = []
        while current in link_targets:
            current_state = state.get(current, 0)
            if current_state == 2:
                final_target = resolved[current]
                break
            if current_state == 1:
                raise ReleaseArchiveError("the archive contains a symbolic link cycle")
            state[current] = 1
            trail.append(current)
            if len(trail) > MAX_SYMLINK_DEPTH:
                raise ReleaseArchiveError("a symbolic link chain exceeds the depth limit")
            current = link_targets[current]
        else:
            if current not in existing_names:
                raise ReleaseArchiveError("a symbolic link target is missing from the archive")
            final_target = current

        for link_name in reversed(trail):
            state[link_name] = 2
            resolved[link_name] = final_target


def validate_members(
    members: Iterable[tarfile.TarInfo],
) -> Tuple[ArchiveMetrics, Dict[str, tarfile.TarInfo]]:
    members_by_name: Dict[str, tarfile.TarInfo] = {}
    link_targets: Dict[str, str] = {}
    expanded_bytes = 0

    for index, member in enumerate(members, start=1):
        if index > MAX_MEMBER_COUNT:
            raise ReleaseArchiveError("the archive contains too many members")
        name = canonical_member_name(member.name)
        if name in members_by_name:
            raise ReleaseArchiveError("the archive contains a duplicate member path")
        if not (
            member.type == tarfile.DIRTYPE
            or is_regular_member(member)
            or member.type == tarfile.SYMTYPE
        ):
            raise ReleaseArchiveError("the archive contains a disallowed member type")
        if member.size < 0:
            raise ReleaseArchiveError("the archive contains a negative member size")
        if is_regular_member(member) and member.issparse():
            raise ReleaseArchiveError("the archive contains a sparse file")
        if is_regular_member(member):
            expanded_bytes += member.size
            if expanded_bytes > MAX_EXPANDED_BYTES:
                raise ReleaseArchiveError("the expanded archive exceeds the size limit")
        if member.issym():
            link_targets[name] = canonical_link_target(name, member.linkname)
        members_by_name[name] = member

    if not members_by_name:
        raise ReleaseArchiveError("the archive is empty")

    effective_entry_count = validate_parent_types(members_by_name)
    validate_symbolic_link_graph(set(members_by_name), link_targets)
    return ArchiveMetrics(0, 0, expanded_bytes, effective_entry_count), members_by_name


def ensure_directory(path: Path, created_directories: Set[Path]) -> None:
    missing: List[Path] = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    if current.is_symlink() or not current.is_dir():
        raise ReleaseArchiveError("an extraction parent is not a real directory")
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        created_directories.add(directory)


def write_regular_member(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    destination: Path,
) -> None:
    source = archive.extractfile(member)
    if source is None:
        raise ReleaseArchiveError("a regular archive member has no data")

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    safe_mode = member.mode & 0o755
    descriptor = os.open(destination, flags, safe_mode)
    written = 0
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            while written < member.size:
                chunk = source.read(min(1024 * 1024, member.size - written))
                if not chunk:
                    raise ReleaseArchiveError("a regular archive member is truncated")
                output.write(chunk)
                written += len(chunk)
            output.flush()
        os.fchmod(descriptor, safe_mode)
    finally:
        source.close()
        os.close(descriptor)


def validate_extracted_tree(root: Path) -> None:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ReleaseArchiveError("the extracted release root is unsafe")
    root_real = root.resolve(strict=True)
    if root_real != root:
        raise ReleaseArchiveError("the extracted release root is not canonical")

    existing_names: Set[str] = set()
    link_targets: Dict[str, str] = {}
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        for entry_name in [*directory_names, *file_names]:
            entry = Path(directory) / entry_name
            entry_status = entry.lstat()
            relative_name = canonical_member_name(entry.relative_to(root).as_posix())
            if relative_name in existing_names:
                raise ReleaseArchiveError("the extracted tree contains a duplicate path")
            existing_names.add(relative_name)
            if stat.S_ISLNK(entry_status.st_mode):
                raw_target = os.readlink(entry)
                link_targets[relative_name] = canonical_link_target(
                    relative_name, raw_target
                )
            elif not (
                stat.S_ISREG(entry_status.st_mode) or stat.S_ISDIR(entry_status.st_mode)
            ):
                raise ReleaseArchiveError("the extracted tree contains a special file")
    validate_symbolic_link_graph(existing_names, link_targets)


def estimate_extraction_bytes(
    members_by_name: Dict[str, tarfile.TarInfo],
    effective_entry_count: int,
    block_size: int,
) -> int:
    estimated = effective_entry_count * block_size
    for member in members_by_name.values():
        if is_regular_member(member):
            estimated += ((member.size + block_size - 1) // block_size) * block_size
    return estimated


def require_extraction_capacity(
    parent: Path,
    members_by_name: Dict[str, tarfile.TarInfo],
    effective_entry_count: int,
) -> None:
    filesystem = os.statvfs(str(parent))
    block_size = max(filesystem.f_frsize, 4096)
    available_bytes = filesystem.f_bavail * filesystem.f_frsize
    required_bytes = estimate_extraction_bytes(
        members_by_name, effective_entry_count, block_size
    )
    if available_bytes - required_bytes < MIN_FREE_BYTES_AFTER_EXTRACTION:
        raise ReleaseArchiveError("the release filesystem lacks the required free-space reserve")
    required_inodes = effective_entry_count + MIN_FREE_INODES_AFTER_EXTRACTION
    if filesystem.f_favail < required_inodes:
        raise ReleaseArchiveError("the release filesystem lacks the required free-inode reserve")


def extract_members(
    archive: tarfile.TarFile,
    members_by_name: Dict[str, tarfile.TarInfo],
    effective_entry_count: int,
    destination: Path,
) -> None:
    if os.name != "posix":
        raise ReleaseArchiveError("release extraction requires a POSIX host")
    if not destination.is_absolute():
        raise ReleaseArchiveError("the extraction destination must be absolute")
    if destination.exists() or destination.is_symlink():
        raise ReleaseArchiveError("the extraction destination already exists")

    parent = destination.parent
    if not parent.exists() or parent.is_symlink() or not parent.is_dir():
        raise ReleaseArchiveError("the extraction parent is unsafe")
    parent_real = parent.resolve(strict=True)
    if parent_real != parent:
        raise ReleaseArchiveError("the extraction parent is not canonical")
    require_extraction_capacity(parent_real, members_by_name, effective_entry_count)

    staging = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.extracting.", dir=parent_real)
    )
    created_directories: Set[Path] = {staging}
    directory_modes: Dict[Path, int] = {staging: 0o755}
    try:
        for name, member in members_by_name.items():
            if not member.isdir():
                continue
            target = staging.joinpath(*PurePosixPath(name).parts)
            ensure_directory(target.parent, created_directories)
            if target.exists():
                if not target.is_dir() or target.is_symlink():
                    raise ReleaseArchiveError("a directory member conflicts during extraction")
            else:
                target.mkdir(mode=0o700)
                created_directories.add(target)
            directory_modes[target] = member.mode & 0o755

        for name, member in members_by_name.items():
            if not is_regular_member(member):
                continue
            target = staging.joinpath(*PurePosixPath(name).parts)
            ensure_directory(target.parent, created_directories)
            write_regular_member(archive, member, target)

        for name, member in members_by_name.items():
            if not member.issym():
                continue
            target = staging.joinpath(*PurePosixPath(name).parts)
            ensure_directory(target.parent, created_directories)
            os.symlink(member.linkname, target)

        for directory in sorted(created_directories, key=lambda item: len(item.parts), reverse=True):
            os.chmod(directory, directory_modes.get(directory, 0o755))
        validate_extracted_tree(staging)
        os.rename(staging, destination)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def validate_archive_path(path: Path) -> int:
    if not path.is_absolute():
        raise ReleaseArchiveError("the archive path must be absolute")
    archive_status = path.lstat()
    if not stat.S_ISREG(archive_status.st_mode):
        raise ReleaseArchiveError("the archive is not a regular file")
    if archive_status.st_size > MAX_COMPRESSED_BYTES:
        raise ReleaseArchiveError("the compressed archive exceeds the size limit")
    return archive_status.st_size


def load_archive(path: Path) -> tarfile.TarFile:
    return tarfile.open(str(path), mode="r:gz")


def main(arguments: List[str]) -> int:
    actions = ("validate", "requirements", "extract", "tree")
    if len(arguments) not in (2, 3) or arguments[0] not in actions:
        print(
            "usage: extract-release-artifact.py validate|requirements <artifact.tgz> | "
            "extract <artifact.tgz> <absolute-destination> | tree <absolute-destination>",
            file=sys.stderr,
        )
        return 2
    action = arguments[0]
    if action in ("validate", "requirements", "tree") and len(arguments) != 2:
        return 2
    if action == "extract" and len(arguments) != 3:
        return 2

    try:
        if action == "tree":
            validate_extracted_tree(Path(arguments[1]))
        else:
            archive_path = Path(arguments[1])
            compressed_bytes = validate_archive_path(archive_path)
            tar_stream_bytes = preflight_tar_stream(archive_path)
            with load_archive(archive_path) as archive:
                metrics, members_by_name = validate_members(archive)
                metrics.compressed_bytes = compressed_bytes
                metrics.tar_stream_bytes = tar_stream_bytes
                if action == "extract":
                    extract_members(
                        archive,
                        members_by_name,
                        metrics.member_count,
                        Path(arguments[2]),
                    )
                elif action == "requirements":
                    print(
                        f"{metrics.compressed_bytes} {metrics.expanded_bytes} "
                        f"{metrics.member_count} {metrics.tar_stream_bytes}"
                    )
    except (OSError, tarfile.TarError, ReleaseArchiveError) as error:
        message = str(error) if isinstance(error, ReleaseArchiveError) else "the archive could not be read or extracted"
        print(f"Release artifact rejected: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
