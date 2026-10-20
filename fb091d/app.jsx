import React from "react";
import { createRoot } from "react-dom/client";
import App from "./AuthApp.jsx";

class AppBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error("Smart Book could not display this page", error); }
  render() {
    if (this.state.failed) return <main style={{padding:32,fontFamily:"sans-serif"}}><h1>Smart Book could not display this page</h1><p>Reload to try again. Check any recent save before repeating it.</p><button onClick={()=>window.location.reload()}>Reload</button></main>;
    return this.props.children;
  }
}
createRoot(document.getElementById("root")).render(<AppBoundary><App /></AppBoundary>);
