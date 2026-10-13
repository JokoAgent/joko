import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const compiler = process.env.CXX || "c++";
const msvc = /(?:^|[\\/])cl(?:\.exe)?$/iu.test(compiler);
function compileAndRun(source, directory, includes = []) {
  const binary = path.join(directory, msvc ? "test.exe" : "test");
  const args = msvc
    ? ["/nologo", "/std:c++20", "/EHsc", "/W4", ...includes.map(value => `/I${value}`),
      source, `/Fo${path.join(directory, "test.obj")}`, `/Fe${binary}`]
    : ["-std=c++20", "-fsanitize=address,undefined", "-g",
      ...includes.flatMap(value => ["-I", value]), source, "-o", binary];
  const result = spawnSync(compiler, args, { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const execution = spawnSync(binary, [], { encoding: "utf8", timeout: 60_000 });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout || String(execution.error));
}


test('missing text and artwork textures never dereference null or shift label indices', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-privacy-textures-'));
  const root = path.dirname(fileURLToPath(import.meta.url));
  try {
    // Compile the actual rendering fragments against failing texture providers.
    // This exercises both allocation and centered draw paths; the Linux compiler adds sanitizers.
    const main = fs.readFileSync(path.join(root, 'main.cpp'), 'utf8');
    const fragment = (start, end) => {
      const from = main.indexOf(start);
      const to = main.indexOf(end, from);
      assert.ok(from >= 0 && to > from, `Missing rendering fragment: ${start}`);
      return main.slice(from, to);
    };
    const artwork = fragment('static SP<ITexture> artwork(', 'static bool active()');
    const labels = fragment('  if (texts.empty()) {', '  bool dialog =');
    const draw = fragment('  auto text =', '\n  };') + '\n  };';
    assert.ok(artwork && labels && draw.includes('renderTexture'));
    const source = path.join(directory, 'test.cpp');
    fs.writeFileSync(
      source,
      `
#include <algorithm>
#include <cassert>
#include <memory>
#include <string>
#include <vector>
template<class T> using SP = std::shared_ptr<T>;
struct ITexture { struct { double x=100, y=20; } m_size; int m_imageDescription=0; };
struct CBox { double x,y,w,h; };
namespace NColorManagement { constexpr int DEFAULT_SRGB_IMAGE_DESCRIPTION=7; }
constexpr int CAIRO_STATUS_READ_ERROR=1, CAIRO_STATUS_SUCCESS=0;
int destroyed=0;
template<class F> void* cairo_image_surface_create_from_png_stream(F, void*) { return nullptr; }
int cairo_surface_status(void*) { return CAIRO_STATUS_SUCCESS; }
void cairo_surface_destroy(void*) { ++destroyed; }
struct Renderer {
  std::vector<CBox> boxes;
  bool failArtwork=true;
  SP<ITexture> createTexture(void*) { return failArtwork ? nullptr : std::make_shared<ITexture>(); }
  SP<ITexture> renderText(const std::string& label, int, int, bool, const char*, int) {
    return label=="missing" ? nullptr : std::make_shared<ITexture>();
  }
  void renderTexture(SP<ITexture> texture, CBox box, int) { assert(texture); boxes.push_back(box); }
} renderer;
auto* g_pHyprRenderer=&renderer;
int foreground() { return 0; }
${artwork}
void check(std::vector<std::string> labels) {
  std::vector<SP<ITexture>> texts;
  ${labels}
  assert(texts.size()==labels.size());
  double scale=2;
  auto* self=&renderer;
  ${draw}
  renderer.boxes.clear();
  text(99, 200, 30, true);
  assert(renderer.boxes.empty());
  for (size_t i=0;i<labels.size();++i) {
    const auto before=renderer.boxes.size();
    for (bool centered : {false,true}) {
      text(i,200,30,centered);
      if (!texts[i]) { assert(renderer.boxes.size()==before); continue; }
      assert(texts[i]->m_imageDescription==7);
      const auto box=renderer.boxes.back();
      assert(box.x==(centered?300:400) && box.y==60 && box.w==200 && box.h==40);
    }
  }
}
int main() {
  check({"missing","missing","missing","missing","missing","missing"});
  check({"missing","ok","ok","missing","ok","missing"});
  check({"ok","missing","missing","ok","missing","ok"});
  check({});
  assert(!artwork(nullptr,0) && destroyed==1);
  renderer.failArtwork=false;
  assert(artwork(nullptr,0)->m_imageDescription==7 && destroyed==2);
}
`,
    );
    compileAndRun(source, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('physical triggers and held edges never reach the remote application or confirm themselves', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-privacy-gate-'));
  const root = path.dirname(fileURLToPath(import.meta.url));
  try {
    const source = path.join(directory, 'test.cpp');
    fs.writeFileSync(
      source,
      `
#include "gate.hpp"
#include <cassert>
int main() {
  PrivacyGate gate;
  assert(!gate.consume(true, 28, true, true));
  gate.phase=PrivacyGate::Active;
  assert(!gate.consume(false, 28, true, true)); // remote Enter is ordinary input
  assert(gate.phase==PrivacyGate::Active);
  assert(!gate.consume(true, 42, false, false)); // release held before activation
  assert(gate.consume(true, 28, true, true));
  assert(gate.phase==PrivacyGate::Pending && gate.held.contains(28));
  assert(gate.consume(false, 28, true, true));
  assert(!gate.consume(false, 30, false, false)); // drain old helper before dialog
  gate.phase=PrivacyGate::Confirming;
  assert(gate.consume(true, 28, true, true)); // repeated initiating Enter
  assert(gate.held.contains(28));
  assert(gate.consume(true, 28, false, false));
  assert(!gate.held.contains(28));
  assert(gate.consume(false, 28, true, true)); // injected Enter cannot confirm
  assert(gate.consume(false, 30, false, false)); // full fence while confirming
  gate.phase=PrivacyGate::Resume;
  assert(gate.consume(true, 1, true, true));
  gate.phase=PrivacyGate::Active;
  assert(gate.consume(true, 1, false, false)); // dialog release cannot leak
  assert(gate.phase==PrivacyGate::Active);
  gate.phase=PrivacyGate::Disconnect;
  assert(gate.consume(false, 30, true, true));
  gate.stop();
  assert(gate.held.empty() && !gate.consume(true, 30, true, true));
}
`,
    );
    compileAndRun(source, directory, [root]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
