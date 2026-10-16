"""Exercise release merges against local repositories without GitHub or deployment calls."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("merge-official-desktop-release.sh")
BRANCH = "personal/spatial-pane-focus"


class ReleaseMergeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="orca-release-merge-")
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name) / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ, BARK_DEVICE_KEY="", ORCA_BACKGROUND_LAUNCH="1")
        self.git("init", "-b", "upstream")
        self.git("config", "user.name", "Release merge test")
        self.git("config", "user.email", "release-test@example.com")
        self.git("config", "commit.gpgsign", "false")
        self.write("scripts/merge-official-desktop-release.sh", SCRIPT.read_text())
        self.write(".github/workflows/existing.yml", "name: original\n")
        self.write(".github/workflows/deleted.yml", "name: deleted\n")
        self.write("product.txt", "original\n")
        self.commit("base")
        self.git("branch", BRANCH)

    def git(self, *args, check=True):
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=self.env,
            text=True, capture_output=True, check=check,
        ).stdout.strip()

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)

    def release(self):
        self.commit("official release")
        self.git("tag", "v1.2.3")
        self.git("checkout", BRANCH)

    def sync(self, *args):
        return subprocess.run(
            ["bash", "scripts/merge-official-desktop-release.sh", "--tag", "v1.2.3", *args],
            cwd=self.repo, env=dict(self.env, UPSTREAM_URL=str(self.repo)),
            text=True, capture_output=True,
        )

    def test_workflow_conflicts_preserve_personal_tree_and_push_exact_branch(self):
        self.write(".github/workflows/deleted.yml", "name: upstream update\n")
        self.write(".github/workflows/existing.yml", "name: upstream update\n")
        self.write(".github/workflows/new production.yml", "name: production\n")
        self.write("product.txt", "official update\n")
        self.release()
        self.git("rm", ".github/workflows/deleted.yml")
        self.write(".github/workflows/existing.yml", "name: personal\n")
        self.commit("personal workflow policy")
        workflows = self.git("rev-parse", "HEAD:.github/workflows")
        before = self.git("rev-parse", "HEAD")
        origin = Path(self.directory.name) / "origin.git"
        self.git("init", "--bare", str(origin))
        self.git("remote", "add", "origin", str(origin))
        self.git("push", "origin", f"HEAD:refs/heads/{BRANCH}")
        result = self.sync("--push")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD:.github/workflows"), workflows)
        self.assertEqual((self.repo / "product.txt").read_text(), "official update\n")
        self.assertEqual(self.git("rev-parse", "HEAD^1"), before)
        self.assertEqual(self.git("rev-parse", "HEAD^2"), self.git("rev-parse", "v1.2.3"))
        self.assertEqual(self.git("--git-dir", str(origin), "rev-parse", f"refs/heads/{BRANCH}"), self.git("rev-parse", "HEAD"))
        head = self.git("rev-parse", "HEAD")
        again = self.sync()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("HEAD already contains v1.2.3", again.stdout)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_upstream_workflow_deletion_keeps_personal_file(self):
        self.git("rm", ".github/workflows/existing.yml")
        self.write("product.txt", "official update\n")
        self.release()
        self.write(".github/workflows/existing.yml", "name: personal\n")
        self.commit("personal workflow")
        workflows = self.git("rev-parse", "HEAD:.github/workflows")
        result = self.sync()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD:.github/workflows"), workflows)

    def test_product_conflict_aborts_without_commit_or_push(self):
        self.write("product.txt", "official update\n")
        self.write(".github/workflows/deleted.yml", "name: upstream update\n")
        self.release()
        self.git("rm", "product.txt", ".github/workflows/deleted.yml")
        self.commit("personal deletion")
        before = self.git("rev-parse", "HEAD")
        result = self.sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("product.txt", result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), before)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertFalse((self.repo / ".git/MERGE_HEAD").exists())

    def test_failed_fetch_does_not_change_personal_branch(self):
        self.write("product.txt", "official update\n")
        self.release()
        self.git("tag", "-d", "v1.2.3")
        before = self.git("rev-parse", "HEAD")
        result = self.sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git("rev-parse", "HEAD"), before)
        self.assertEqual(self.git("status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main()
