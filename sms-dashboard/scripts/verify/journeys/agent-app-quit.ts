// Agent app: after its settings window has been open, 退出 still quits (agent-app,
// GRA-230). Teardown quits the app with app.quit() and fails the run if it lingers.
import type { Journey } from '../journey.ts';

const journey: Journey = async ({ agentApp, evidence }) => {
  const app = await agentApp();
  const window = await app.open();
  await evidence('app-window', { title: await window.title() });
};

export default journey;
