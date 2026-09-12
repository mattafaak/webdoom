---
name: Bug report
about: Something in the game, the launcher, the server or a gate is wrong
labels: bug
---

**What happened, and what you expected instead**



**How to reproduce it**

<!-- The most useful bug report here is one that can be turned into a
     failing gate. If you can name the leg it should have been caught by,
     say so; `tools/run-tests.sh --list` prints them all. -->

1.
2.
3.

**Which of these is it?**

- [ ] The simulation diverged (a demo did not replay identically, or
      players desynced). **Please say which WAD and which demo.**
- [ ] The launcher, settings or lobby
- [ ] The server (crash, wedge, resource growth)
- [ ] Rendering
- [ ] Audio
- [ ] A gate that passes over a defect, or fails over a non-defect

**Environment**

- Browser and version:
- OS:
- `node --version`:
- Built from commit:
- Output of `bash tools/run-tests.sh --quick` (if it is not green):

```
```

**Anything in the console or the server log?**

```
```
