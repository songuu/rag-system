#!/usr/bin/env python3
import io
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest


DIRECTORY = Path(__file__).resolve().parent
EXTRACTOR = DIRECTORY / "extract-release-artifact.py"
EXTRACTOR_SPEC = importlib.util.spec_from_file_location(
    "release_artifact_extractor", str(EXTRACTOR)
)
EXTRACTOR_MODULE = importlib.util.module_from_spec(EXTRACTOR_SPEC)
EXTRACTOR_SPEC.loader.exec_module(EXTRACTOR_MODULE)
TEST_TEMP_ROOT = (
    DIRECTORY.parents[1] / ".codex-tmp" / "release-artifact-tests"
    if os.name == "nt"
    else None
)
if TEST_TEMP_ROOT is not None:
    TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


def make_temporary_directory():
    return tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)


def add_directory(archive: tarfile.TarFile, name: str, mode: int = 0o755) -> None:
    member = tarfile.TarInfo(name)
    member.type = tarfile.DIRTYPE
    member.mode = mode
    archive.addfile(member)


def add_file(
    archive: tarfile.TarFile,
    name: str,
    content: bytes = b"fixture",
    mode: int = 0o644,
) -> None:
    member = tarfile.TarInfo(name)
    member.size = len(content)
    member.mode = mode
    archive.addfile(member, io.BytesIO(content))


def add_link(
    archive: tarfile.TarFile,
    name: str,
    target: str,
    link_type: bytes = tarfile.SYMTYPE,
) -> None:
    member = tarfile.TarInfo(name)
    member.type = link_type
    member.linkname = target
    member.mode = 0o777
    archive.addfile(member)


def add_special(archive: tarfile.TarFile, name: str, member_type: bytes) -> None:
    member = tarfile.TarInfo(name)
    member.type = member_type
    archive.addfile(member)


def write_archive(path: Path, populate) -> None:
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        populate(archive)


def run_extractor(*arguments: str):
    return subprocess.run(
        [sys.executable, str(EXTRACTOR), *arguments],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        timeout=15,
    )


class ReleaseArtifactExtractorTest(unittest.TestCase):
    def test_accepts_internal_pnpm_links_and_extracts_them_on_posix(self) -> None:
        with make_temporary_directory() as temporary_directory:
            temporary = Path(temporary_directory)
            archive_path = temporary / "release.tgz"

            def populate(archive: tarfile.TarFile) -> None:
                for directory in (
                    "node_modules",
                    "node_modules/.pnpm",
                    "node_modules/.pnpm/pg@8",
                    "node_modules/.pnpm/pg@8/node_modules",
                    "node_modules/.pnpm/pg@8/node_modules/pg",
                    "node_modules/.pnpm/consumer",
                    "node_modules/.pnpm/consumer/node_modules",
                    "node_modules/.pnpm/dependency",
                    "node_modules/.pnpm/dependency/node_modules",
                    "node_modules/.pnpm/dependency/node_modules/dependency",
                ):
                    add_directory(archive, directory)
                add_file(
                    archive,
                    "node_modules/.pnpm/pg@8/node_modules/pg/package.json",
                    b'{"name":"pg"}',
                )
                add_file(
                    archive,
                    "node_modules/.pnpm/dependency/node_modules/dependency/index.js",
                    b"export {};",
                    mode=0o6777,
                )
                add_link(archive, "node_modules/pg", ".pnpm/pg@8/node_modules/pg")
                add_link(
                    archive,
                    "node_modules/.pnpm/consumer/node_modules/dependency",
                    "../../dependency/node_modules/dependency",
                )

            write_archive(archive_path, populate)

            validation = run_extractor("validate", str(archive_path))
            self.assertEqual(validation.returncode, 0, validation.stderr)
            requirements = run_extractor("requirements", str(archive_path))
            self.assertEqual(requirements.returncode, 0, requirements.stderr)
            self.assertEqual(len(requirements.stdout.strip().split(" ")), 4)

            if os.name == "nt":
                self.skipTest("Windows test users cannot create symbolic links without elevation")

            destination = temporary / "release"
            extraction = run_extractor("extract", str(archive_path), str(destination))
            self.assertEqual(extraction.returncode, 0, extraction.stderr)
            tree_validation = run_extractor("tree", str(destination))
            self.assertEqual(tree_validation.returncode, 0, tree_validation.stderr)
            self.assertTrue((destination / "node_modules" / "pg").is_symlink())
            self.assertEqual(
                (destination / "node_modules" / "pg" / "package.json").read_text(),
                '{"name":"pg"}',
            )
            self.assertTrue(
                (
                    destination
                    / "node_modules/.pnpm/consumer/node_modules/dependency"
                ).is_symlink()
            )
            executable = (
                destination
                / "node_modules/.pnpm/dependency/node_modules/dependency/index.js"
            )
            self.assertEqual(executable.stat().st_mode & 0o7777, 0o755)

            public_link = destination / "node_modules" / "pg"
            public_link.unlink()
            os.symlink(
                ".pnpm/../.pnpm/pg@8/node_modules/pg",
                public_link,
            )
            ambiguous_tree = run_extractor("tree", str(destination))
            self.assertNotEqual(ambiguous_tree.returncode, 0)

            public_link.unlink()
            os.symlink("/etc/passwd", public_link)
            escaped_tree = run_extractor("tree", str(destination))
            self.assertNotEqual(escaped_tree.returncode, 0)

    def test_rejects_unsafe_archive_members_before_extraction(self) -> None:
        cases = {
            "absolute member": lambda archive: add_file(archive, "/outside.txt"),
            "parent traversal": lambda archive: add_file(archive, "../outside.txt"),
            "absolute symlink": lambda archive: (
                add_directory(archive, "node_modules"),
                add_link(archive, "node_modules/pg", "/etc/passwd"),
            ),
            "escaping symlink": lambda archive: (
                add_directory(archive, "node_modules"),
                add_link(archive, "node_modules/pg", "../../outside"),
            ),
            "parent segment after normal component": lambda archive: (
                add_directory(archive, "real"),
                add_file(archive, "target"),
                add_link(archive, "alias", "real/../target"),
            ),
            "hard link": lambda archive: (
                add_file(archive, "target"),
                add_link(archive, "alias", "target", tarfile.LNKTYPE),
            ),
            "fifo": lambda archive: add_special(archive, "pipe", tarfile.FIFOTYPE),
            "character device": lambda archive: add_special(
                archive, "device", tarfile.CHRTYPE
            ),
            "block device": lambda archive: add_special(
                archive, "device", tarfile.BLKTYPE
            ),
            "GNU sparse": lambda archive: add_special(
                archive, "sparse", tarfile.GNUTYPE_SPARSE
            ),
            "control character": lambda archive: add_file(archive, "bad\nname"),
            "repeated separator": lambda archive: add_file(archive, "bad//name"),
            "Windows drive syntax": lambda archive: add_file(archive, "C:/outside"),
            "missing link target": lambda archive: add_link(
                archive, "node_modules/pg", ".pnpm/missing"
            ),
        }

        for name, populate in cases.items():
            with self.subTest(name=name), make_temporary_directory() as temporary_directory:
                temporary = Path(temporary_directory)
                archive_path = temporary / "release.tgz"
                write_archive(archive_path, populate)

                result = run_extractor("validate", str(archive_path))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Release artifact rejected", result.stderr)

    def test_rejects_oversized_pax_metadata_before_tarfile_parses_it(self) -> None:
        with make_temporary_directory() as temporary_directory:
            temporary = Path(temporary_directory)
            archive_path = temporary / "release.tgz"

            def populate(archive: tarfile.TarFile) -> None:
                member = tarfile.TarInfo("server.js")
                member.pax_headers = {"comment": "x" * (2 * 1024 * 1024)}
                archive.addfile(member, io.BytesIO())

            write_archive(archive_path, populate)
            result = run_extractor("validate", str(archive_path))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("metadata record exceeds", result.stderr)

    def test_rejects_pax_and_solaris_metadata_extensions(self) -> None:
        cases = {
            "PAX size override": lambda archive: self._add_pax_member(
                archive, {"size": "1"}
            ),
            "PAX sparse map": lambda archive: self._add_pax_member(
                archive, {"GNU.sparse.map": "0,1"}
            ),
            "Solaris PAX": lambda archive: add_special(
                archive, "metadata", getattr(tarfile, "SOLARIS_XHDTYPE", b"X")
            ),
        }

        for name, populate in cases.items():
            with self.subTest(name=name), make_temporary_directory() as temporary_directory:
                temporary = Path(temporary_directory)
                archive_path = temporary / "release.tgz"
                write_archive(archive_path, populate)
                result = run_extractor("validate", str(archive_path))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unsupported metadata extension", result.stderr)

    @staticmethod
    def _add_pax_member(archive: tarfile.TarFile, headers) -> None:
        member = tarfile.TarInfo("server.js")
        member.size = 1
        member.pax_headers = headers
        archive.addfile(member, io.BytesIO(b"x"))

    def test_counts_implicit_parent_directories_in_capacity_requirements(self) -> None:
        with make_temporary_directory() as temporary_directory:
            temporary = Path(temporary_directory)
            archive_path = temporary / "release.tgz"
            write_archive(
                archive_path,
                lambda archive: add_file(archive, "one/two/three/server.js"),
            )
            result = run_extractor("requirements", str(archive_path))
            self.assertEqual(result.returncode, 0, result.stderr)
            measurements = [int(value) for value in result.stdout.strip().split(" ")]
            self.assertEqual(measurements[2], 4)

            member = tarfile.TarInfo("one/two/three/server.js")
            member.size = 7
            estimated = EXTRACTOR_MODULE.estimate_extraction_bytes(
                {member.name: member}, measurements[2], 4096
            )
            self.assertEqual(estimated, 5 * 4096)

    def test_validates_a_long_symbolic_link_chain_without_quadratic_walks(self) -> None:
        with make_temporary_directory() as temporary_directory:
            temporary = Path(temporary_directory)
            archive_path = temporary / "release.tgz"

            def populate(archive: tarfile.TarFile) -> None:
                add_file(archive, "target")
                for index in range(4000):
                    target = "target" if index == 3999 else f"link-{index + 1}"
                    add_link(archive, f"link-{index}", target)

            write_archive(archive_path, populate)
            result = run_extractor("validate", str(archive_path))
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_tree_validation_memoizes_many_links_with_one_shared_tail(self) -> None:
        if os.name == "nt":
            self.skipTest("Windows test users cannot create symbolic links without elevation")
        with make_temporary_directory() as temporary_directory:
            root = Path(temporary_directory).resolve() / "release"
            root.mkdir()
            (root / "target").write_bytes(b"fixture")
            for index in range(1000):
                target = "target" if index == 999 else "tail-{0}".format(index + 1)
                os.symlink(target, root / "tail-{0}".format(index))
            for index in range(4000):
                os.symlink("tail-0", root / "alias-{0}".format(index))

            started = time.monotonic()
            result = run_extractor("tree", str(root))
            elapsed = time.monotonic() - started
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertLess(elapsed, 5.0)

    def test_rejects_duplicate_cycles_and_members_below_a_symlink(self) -> None:
        cases = {
            "duplicate": lambda archive: (
                add_file(archive, "server.js", b"one"),
                add_file(archive, "server.js", b"two"),
            ),
            "cycle": lambda archive: (
                add_link(archive, "a", "b"),
                add_link(archive, "b", "a"),
            ),
            "symlink ancestor": lambda archive: (
                add_directory(archive, "real"),
                add_link(archive, "alias", "real"),
                add_file(archive, "alias/payload.js"),
            ),
        }

        for name, populate in cases.items():
            with self.subTest(name=name), make_temporary_directory() as temporary_directory:
                temporary = Path(temporary_directory)
                archive_path = temporary / "release.tgz"
                write_archive(archive_path, populate)
                result = run_extractor("validate", str(archive_path))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Release artifact rejected", result.stderr)

    def test_requires_an_empty_canonical_destination(self) -> None:
        with make_temporary_directory() as temporary_directory:
            temporary = Path(temporary_directory)
            archive_path = temporary / "release.tgz"
            write_archive(archive_path, lambda archive: add_file(archive, "server.js"))
            destination = temporary / "release"
            destination.mkdir()
            (destination / "existing.txt").write_text("do not overwrite")

            result = run_extractor("extract", str(archive_path), str(destination))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((destination / "existing.txt").read_text(), "do not overwrite")


if __name__ == "__main__":
    unittest.main()
