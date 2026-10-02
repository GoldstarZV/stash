const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

// Run the real TypeScript controller with video.js's event/component boundary
// stubbed. Rendering and media decoding are covered by the sandbox checks.
function loadSource(file, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return exports;
}

const vrUtils = loadSource("utils/vr.ts");

class Events extends EventEmitter {
  trigger(name, data) {
    this.emit(name, {}, data);
  }
}

function setup(userAgent = "Desktop") {
  class Component extends Events {
    constructor(player, options) {
      super();
      this.owner = player;
      this.options = options;
    }
    player() {
      return this.owner;
    }
    addClass() {}
    selected() {}
    update() {
      this.createItems();
    }
    el() {
      return {};
    }
  }
  class Plugin extends Events {
    constructor(player) {
      super();
      this.player = player;
    }
  }
  const videojs = {
    getComponent: () => Component,
    getPlugin: () => Plugin,
    registerComponent() {},
    registerPlugin() {},
  };
  const { default: VRMenuPlugin } = loadSource(
    "components/ScenePlayer/vrmode.ts",
    {
      "video.js": { default: videojs },
      "@blaineam/videojs-vr": {},
      "src/utils/vr": vrUtils,
    },
    { navigator: { userAgent } }
  );
  const player = new Events();
  const buttons = new Set();
  player.controlBar = {
    getChild: () => ({ el: () => ({}) }),
    el: () => ({ insertBefore() {} }),
    addChild(button) {
      assert.ok(!buttons.has(button));
      buttons.add(button);
    },
    removeChild(button) {
      buttons.delete(button);
    },
  };
  const vr = new Events();
  vr.projection = "AUTO";
  vr.inits = [];
  vr.selections = [];
  vr.setProjection = (projection) => {
    vr.projection = projection;
    vr.selections.push(projection);
  };
  vr.init = () => {
    vr.inits.push(vr.projection);
    vr.videoTexture = {};
    vr.trigger("initialized");
  };
  let vrCalls = 0;
  player.vr = () => {
    vrCalls++;
    // videojs-vr registers this before the controller's colour-space handler.
    player.on("loadedmetadata", vr.init);
    return vr;
  };
  const controller = new VRMenuPlugin(player, {});
  const menu = controller.menu;
  return {
    controller,
    player,
    vr,
    buttons,
    get vrCalls() {
      return vrCalls;
    },
    metadata() {
      player.trigger("loadedmetadata");
    },
    sourceChange() {
      player.trigger("loadstart");
    },
    choose(label) {
      menu
        .createItems()
        .find((i) => i.options.label === label)
        .handleClick();
    },
    selected() {
      return menu
        .createItems()
        .filter((i) => i.isSelected)
        .map((i) => i.options.label)
        .join();
    },
  };
}

test("missing and invalid settings resolve to Off", () => {
  for (const value of [undefined, null, "", "AUTO", "180", {}, 1, "NONE"]) {
    assert.equal(vrUtils.resolveVRProjection(value), "NONE");
    const s = setup();
    s.controller.setScene("1", true, value);
    s.metadata();
    assert.equal(s.vr.projection, "NONE");
    assert.equal(s.selected(), "Off");
  }
});

for (const [projection, label] of [
  ["NONE", "Off"],
  ["180_LR", "180 LR"],
  ["360_TB", "360 TB"],
  ["360", "360 Mono"],
]) {
  test(`${label}: initial selection, menu synchronization and source reload`, () => {
    const s = setup();
    s.controller.setScene("1", true, projection);
    assert.equal(s.selected(), label);
    const initial = projection === "NONE" ? [] : [projection];
    assert.deepEqual(s.vr.inits, initial, "project the poster before metadata");
    s.player.trigger("ready");
    assert.equal(s.buttons.size, 1);
    s.metadata();
    s.controller.setScene("1", true, projection);
    assert.deepEqual(s.vr.inits, [...initial, projection]);
    s.sourceChange();
    s.metadata();
    assert.deepEqual(s.vr.inits, [...initial, projection, projection]);
    assert.equal(s.selected(), label);
  });
}

test("manual choices including Off survive repeated updates and source changes", () => {
  const s = setup();
  s.controller.setScene("1", true, "180_LR");
  s.metadata();
  for (const [label, projection] of [
    ["360 TB", "360_TB"],
    ["Off", "NONE"],
    ["360 Mono", "360"],
  ]) {
    s.choose(label);
    const count = s.vr.inits.length;
    s.choose(label);
    s.controller.setScene("1", true, "180_LR");
    assert.equal(s.vr.inits.length, count);
    s.sourceChange();
    s.metadata();
    assert.equal(s.vr.projection, projection);
    assert.equal(s.selected(), label);
  }
});

test("navigation reapplies defaults to tagged and untagged scenes", () => {
  const s = setup();
  s.controller.setScene("1", true, "180_LR");
  s.metadata();
  s.choose("Off");
  const count = s.vr.inits.length;
  s.sourceChange();
  s.controller.setScene("2", true, "180_LR");
  assert.equal(s.vr.inits.length, count + 1);
  s.metadata();
  assert.equal(s.selected(), "180 LR");
  s.sourceChange();
  s.controller.setScene("3", false, "180_LR");
  s.metadata();
  assert.equal(s.vr.projection, "NONE");
  assert.equal(s.selected(), "Off");
  assert.equal(s.buttons.size, 0);
});

test("deliberate changes to configuration or eligibility reapply defaults", () => {
  const s = setup();
  s.controller.setScene("1", true, "180_LR");
  s.metadata();
  s.choose("Off");
  s.controller.setScene("1", true, "360_TB");
  assert.equal(s.selected(), "360 TB");
  assert.equal(s.vr.inits.at(-1), "360_TB");
  s.controller.setScene("1", false, "360_TB");
  assert.equal(s.vr.inits.at(-1), "NONE");
  s.controller.setScene("1", true, "360_TB");
  assert.equal(s.vr.inits.at(-1), "360_TB");
});

test("manual selection while loading is used when metadata arrives", () => {
  const s = setup();
  s.controller.setScene("1", true, "180_LR");
  s.choose("Off");
  s.metadata();
  assert.deepEqual(s.vr.inits, ["180_LR", "NONE", "NONE"]);
});

test("hiding the VR button also disables projection and synchronizes the menu", () => {
  const s = setup();
  s.controller.setScene("1", true, "180_LR");
  s.metadata();
  const count = s.vr.inits.length;
  s.controller.setShowButton(false);
  assert.equal(s.buttons.size, 0);
  assert.equal(s.vr.projection, "NONE");
  assert.equal(s.selected(), "Off");
  assert.equal(s.vr.inits.length, count + 1);
  s.controller.setShowButton(false);
  assert.equal(s.vr.inits.length, count + 1);
  s.sourceChange();
  s.metadata();
  assert.equal(s.vr.projection, "NONE");
  s.controller.setShowButton(true);
  assert.equal(s.buttons.size, 1);
  assert.equal(s.selected(), "Off");
});

test("a second scene with the same default refreshes its paused poster once", () => {
  const s = setup();
  s.controller.setScene("1", true, "180_LR");
  s.sourceChange();
  s.controller.setScene("2", true, "180_LR");
  s.controller.setScene("2", true, "180_LR");
  assert.deepEqual(s.vr.inits, ["180_LR", "180_LR"]);
});

test("existing texture colour-space workaround remains active", () => {
  const s = setup();
  s.controller.setScene("1", true, "180_LR");
  s.metadata();
  assert.equal(s.vr.videoTexture.colorSpace, "srgb");
  s.vr.posterTexture = {};
  assert.equal(s.vr.posterTexture.colorSpace, "srgb");
});

test("headset browsers remain excluded", () => {
  for (const userAgent of ["OculusBrowser/1.0", "Example VR Browser"]) {
    const s = setup(userAgent);
    s.controller.setScene("1", true, "180_LR");
    s.player.trigger("ready");
    assert.equal(s.vrCalls, 0);
    assert.equal(s.buttons.size, 0);
    assert.equal(s.vr.selections.length, 0);
  }
});
