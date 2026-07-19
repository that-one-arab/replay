import { Background } from "./components/Background";
import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { Problem } from "./components/Problem";
import { HowItWorks } from "./components/HowItWorks";
import { IdleTreatment } from "./components/IdleTreatment";
import { Features } from "./components/Features";
import { AskAI } from "./components/AskAI";
import { TerraSection } from "./components/TerraSection";
import { CodeShowcase } from "./components/CodeShowcase";
import { FinalCTA } from "./components/FinalCTA";
import { Footer } from "./components/Footer";

export default function App() {
  return (
    <div className="relative min-h-screen">
      <Background />
      <Nav />
      <main className="overflow-x-clip">
        <Hero />
        <Problem />
        <HowItWorks />
        <IdleTreatment />
        <Features />
        <AskAI />
        <TerraSection />
        <CodeShowcase />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
