defmodule Data.Repo.Migrations.CreateDirectoryTable do
  use Ecto.Migration

  def change do
    create table(:documents, primary_key: false) do
      add :id,    :uuid, primary_key: true
      add :name,  :string

      timestamps()
    end

    create table(:entities, primary_key: false) do
      add :id,          :uuid, primary_key: true
      add :data,        :map
      add :document_id, references(:documents, type: :binary_id)

      timestamps()
    end

    create unique_index(:documents, [:name])
  end
end
