import videojs, { VideoJsPlayer } from "video.js";
import "@blaineam/videojs-vr";
// separate type import, otherwise typescript elides the above import
// and the plugin does not get initialized
import type { Plugin as VideoJsVRPlugin } from "@blaineam/videojs-vr";
import { resolveVRProjection, VRProjection } from "src/utils/vr";

export interface VRMenuOptions {
  /**
   * Whether to show the vr button.
   * @default false
   */
  showButton?: boolean;
}

enum VRType {
  LR180 = "180 LR",
  TB360 = "360 TB",
  Mono360 = "360 Mono",
  Off = "Off",
}

const vrTypeProjection: Record<VRType, VRProjection> = {
  [VRType.LR180]: "180_LR",
  [VRType.TB360]: "360_TB",
  [VRType.Mono360]: "360",
  [VRType.Off]: "NONE",
};

function isVrDevice() {
  return navigator.userAgent.match(/oculusbrowser|\svr\s/i);
}

class VRMenuItem extends videojs.getComponent("MenuItem") {
  public type: VRType;
  public isSelected = false;

  constructor(parent: VRMenuButton, type: VRType) {
    const options: videojs.MenuItemOptions = {};
    options.selectable = true;
    options.multiSelectable = false;
    options.label = type;

    super(parent.player(), options);

    this.type = type;

    this.addClass("vjs-source-menu-item");
  }

  selected(selected: boolean): void {
    super.selected(selected);
    this.isSelected = selected;
  }

  handleClick() {
    if (this.isSelected) return;

    this.trigger("selected");
  }
}

class VRMenuButton extends videojs.getComponent("MenuButton") {
  private items: VRMenuItem[] = [];
  private selectedType: VRType = VRType.Off;

  constructor(player: VideoJsPlayer) {
    super(player);
    this.setTypes();
  }

  private onSelected(item: VRMenuItem) {
    this.trigger("typeselected", item.type);
  }

  public setSelectedType(type: VRType) {
    this.selectedType = type;

    this.items.forEach((i) => {
      i.selected(i.type === this.selectedType);
    });
  }

  public setTypes() {
    this.items = Object.values(VRType).map((type) => {
      const item = new VRMenuItem(this, type);

      item.on("selected", () => {
        this.onSelected(item);
      });

      return item;
    });
    this.update();
  }

  createEl() {
    return videojs.dom.createEl("div", {
      className:
        "vjs-vr-selector vjs-menu-button vjs-menu-button-popup vjs-control vjs-button",
    });
  }

  createItems() {
    if (this.items === undefined) return [];

    for (const item of this.items) {
      item.selected(item.type === this.selectedType);
    }

    return this.items;
  }
}

class VRMenuPlugin extends videojs.getPlugin("plugin") {
  private menu: VRMenuButton;
  private showButton: boolean;
  private vr?: VideoJsVRPlugin;
  private scene?: { id: string; eligible: boolean; projection: VRProjection };
  private projection?: VRProjection;
  private buttonAdded = false;

  constructor(player: VideoJsPlayer, options: VRMenuOptions) {
    super(player);

    this.menu = new VRMenuButton(player);
    this.showButton = options.showButton ?? false;

    if (isVrDevice()) return;

    this.vr = this.player.vr();

    // Temporary workaround for an upstream videojs-vr colour-space bug.
    // Remove this workaround once we use a version that tags its textures as sRGB.
    // videojs-vr creates its textures without a colour space, so three.js
    // treats the sRGB video as linear and gamma-encodes it a second time on
    // output, leaving the video washed out. Posters load asynchronously without
    // an event, so tag them on assignment, before they are applied to materials.
    let posterTexture = this.vr.posterTexture;
    Object.defineProperty(this.vr, "posterTexture", {
      configurable: true,
      enumerable: true,
      get: () => posterTexture,
      set: (texture: VideoJsVRPlugin["posterTexture"]) => {
        if (texture && texture.colorSpace !== "srgb") {
          texture.colorSpace = "srgb";
          texture.needsUpdate = true;
        }
        posterTexture = texture;
      },
    });

    // init recreates the video texture. Its XR source-change path returns before
    // initialized, so also run after the plugin's loadedmetadata handler.
    this.vr.on("initialized", () => this.fixTextureColorSpace());
    player.on("loadedmetadata", () => this.fixTextureColorSpace());

    this.menu.on("typeselected", (_, type: VRType) => {
      this.selectProjection(vrTypeProjection[type]);
    });

    player.on("ready", () => {
      if (this.showButton) {
        this.addButton();
      }
    });
  }

  private selectProjection(projection: VRProjection, newScene = false) {
    const type = Object.values(VRType).find(
      (value) => vrTypeProjection[value] === projection
    )!;
    this.menu.setSelectedType(type);
    if (projection === this.projection && !newScene) return;
    const previous = this.projection;
    this.projection = projection;
    this.vr?.setProjection(projection);
    // Initialize paused posters too. videojs-vr retains this projection when
    // it initializes again on loadedmetadata (including quality changes).
    if (projection !== "NONE" || (previous && previous !== "NONE")) {
      this.vr?.init();
    }
  }

  public setScene(id: string, eligible: boolean, defaultProjection: unknown) {
    if (isVrDevice()) return;

    const projection = resolveVRProjection(defaultProjection);
    const previous = this.scene;
    if (
      previous?.id === id &&
      previous.eligible === eligible &&
      previous.projection === projection
    ) {
      return;
    }

    this.scene = { id, eligible, projection };
    this.setShowButton(eligible);
    this.selectProjection(eligible ? projection : "NONE", previous?.id !== id);
  }

  private fixTextureColorSpace() {
    const texture = this.vr?.videoTexture;
    if (texture && texture.colorSpace !== "srgb") {
      texture.colorSpace = "srgb";
      texture.needsUpdate = true;
    }
  }

  private addButton() {
    if (this.buttonAdded) return;
    const { controlBar } = this.player;
    const fullscreenToggle = controlBar.getChild("fullscreenToggle")!.el();
    controlBar.addChild(this.menu);
    controlBar.el().insertBefore(this.menu.el(), fullscreenToggle);
    this.buttonAdded = true;
  }

  private removeButton() {
    if (!this.buttonAdded) return;
    const { controlBar } = this.player;
    controlBar.removeChild(this.menu);
    this.buttonAdded = false;
  }

  public setShowButton(showButton: boolean) {
    if (isVrDevice()) return;

    if (showButton === this.showButton) return;

    this.showButton = showButton;
    if (showButton) {
      this.addButton();
    } else {
      this.removeButton();
      this.selectProjection("NONE");
    }
  }
}

// Register the plugin with video.js.
videojs.registerComponent("VRMenuButton", VRMenuButton);
videojs.registerPlugin("vrMenu", VRMenuPlugin);

declare module "video.js" {
  interface VideoJsPlayer {
    vrMenu: () => VRMenuPlugin;
  }
  interface VideoJsPlayerPluginOptions {
    vrMenu?: VRMenuOptions;
  }
}

export default VRMenuPlugin;
