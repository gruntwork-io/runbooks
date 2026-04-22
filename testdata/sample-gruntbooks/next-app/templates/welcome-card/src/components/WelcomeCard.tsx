interface WelcomeCardProps {
  title?: string
  description?: string
}

export default function WelcomeCard({
  title = "{{ .inputs.Title }}",
  description = "{{ .inputs.Description }}",
}: WelcomeCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="mb-2 text-2xl font-bold tracking-tight">{title}</h2>
      <p className="text-gray-600 dark:text-gray-400">{description}</p>
    </div>
  )
}
