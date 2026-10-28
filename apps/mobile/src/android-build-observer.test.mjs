import { expect, it } from "vitest";
import { parseAndroidBuildThreads } from "../../../scripts/ci/android-build-observer.mjs";

it("retains JVM state and whitelisted Gradle frames without names, arguments, locks or private output", () => {
  const snapshot = parseAndroidBuildThreads([
    '"PRIVATE_THREAD_NAME" #1 prio=5 tid=0x01 nid=0x02 runnable',
    "   java.lang.Thread.State: WAITING (parking)",
    "\tat java.base@17.0.17/java.lang.Object.wait(Native Method)",
    "\tat org.gradle.process.internal.DefaultExecHandle.waitForFinish(DefaultExecHandle.java:371)",
    "\tat private.application.SecretTask.run(SecretTask.java:99)",
    "\t- locked <0xdeadbeef> (a private.SecretLock)",
    "PASSWORD=PRIVATE_PASSWORD commandLine=PRIVATE_COMMAND keystore=PRIVATE_KEYSTORE",
    "\tat org.gradle.privateMethod.run(secret parameter)",
    "java.lang.Exception: PRIVATE_ERROR_MESSAGE"
  ].join("\n"));
  expect(snapshot).toEqual({ totalThreads: 1, states: { WAITING: 1 }, truncated: false, deadlock: false,
    threads: [{ state: "WAITING", frames: ["java.lang.Object.wait(Native Method)", "org.gradle.process.internal.DefaultExecHandle.waitForFinish(DefaultExecHandle.java:371)"] }] });
  const text = JSON.stringify(snapshot);
  for (const hidden of ["PRIVATE_", "SecretTask", "SecretLock", "deadbeef", "secret parameter"]) expect(text).not.toContain(hidden);
});

it("bounds thread details and prioritizes the native configure blockage while counting all states", () => {
  const waiting = Array.from({ length: 20 }, (_, index) => `"worker-${index}"\n   java.lang.Thread.State: WAITING\n\tat java.lang.Object.wait(Native Method)`);
  const snapshot = parseAndroidBuildThreads([...waiting, '"private blocked task"\n   java.lang.Thread.State: BLOCKED\n\tat com.android.build.gradle.tasks.NativeBuild.run(NativeBuild.java:15)'].join("\n"));
  expect(snapshot.totalThreads).toBe(21); expect(snapshot.states).toEqual({ WAITING: 20, BLOCKED: 1 });
  expect(snapshot.threads).toHaveLength(12);
  expect(snapshot.threads[0]).toEqual({ state: "BLOCKED", frames: ["com.android.build.gradle.tasks.NativeBuild.run(NativeBuild.java:15)"] });
});

it("does not report unparsed attach errors or heap and property text as thread evidence", () => {
  expect(parseAndroidBuildThreads("PRIVATE_ATTACH_ERROR\njava.home=/private\nPASSWORD=hidden\nHeap\n  PRIVATE_OBJECT_DATA"))
    .toEqual({ totalThreads: 0, states: {}, truncated: false, deadlock: false, threads: [] });
  expect(parseAndroidBuildThreads("x".repeat(1024 * 1024 + 1))).toMatchObject({ totalThreads: 0, truncated: true });
});
