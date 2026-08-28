import LoadPlanner from "../../LoadPlanner";

export default async function SharedPlanPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const resolved = await params;
  return <LoadPlanner initialShareId={resolved.id} />;
}
