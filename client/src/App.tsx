import { AppProviders } from "./app/providers";
import { AppRoutes } from "./app/routes";
import { BlogWidgets } from "./components/blog-widgets";
import { useAppBootstrap } from "./app/use-app-bootstrap";

function App() {
  const { config, profile } = useAppBootstrap();

  return (
    <AppProviders config={config} profile={profile}>
      <AppRoutes />
      <BlogWidgets />
    </AppProviders>
  )
}

export default App
