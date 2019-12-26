defmodule Data.Repo.Migrations.CreateAttachmentTable do
  use Ecto.Migration

  def change do
    create table(:attachments, primary_key: false) do
      add :id,    :uuid,    primary_key: true
      add :name,  :string,  null: true
      add :file,  :string

      timestamps()
    end
  end
end
