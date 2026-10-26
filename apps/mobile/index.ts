import { registerRootComponent } from "expo";
import "./src/mobile-abort-runtime";
import "./src/mobile-crypto-runtime";
import "./src/mobile-linkspan-runtime";
import { App } from "./src/App";

registerRootComponent(App);
