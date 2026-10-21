import { render } from "preact";
import { App } from "./components/App.js";
import "./styles.css";
import { applyTheme, theme } from "./theme.js";

applyTheme(theme.value);
render(<App />, document.getElementById("app")!);
