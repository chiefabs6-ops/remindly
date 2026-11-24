// One project (mockup E). Placeholder until step C3 lands.
import { useParams } from "react-router";
export function ProjectPage() {
  const { projectId } = useParams();
  return <div className="p-7" data-project={projectId}><h1 className="text-[22px] font-semibold">Project</h1></div>;
}
