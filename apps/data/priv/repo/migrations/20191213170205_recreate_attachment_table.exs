defmodule Data.Repo.Migrations.RecreateAttachmentTable do
  use Ecto.Migration

  def change do
    drop table(:attachments)

    create table(:attachments, primary_key: false) do
      add :id,        :uuid,   primary_key: true
      add :name,      :string, null: true
      add :file,      :string
      add :owner_id,  :string, null: true

      timestamps()
    end

  end
end
