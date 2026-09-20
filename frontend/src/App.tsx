import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./pages/Dashboard";
import { Vendors } from "./pages/Vendors";
import { Routing } from "./pages/Routing";
import { Settings } from "./pages/Settings";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/vendors" element={<Vendors />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
