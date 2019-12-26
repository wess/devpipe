#
#  document.ex
#  models
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Model.Document do
  use Schema

  @required_fields [:name]
  @optional_fields []

  @derive {Jason.Encoder, except: [:__meta__, :entites]}
  schema "documents" do
    field :name, :string

    timestamps()

    has_many :entities, Model.Entity
  end

  def changeset(struct, params \\ %{}) do
    struct
    |> cast(params, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> unique_constraint(:name)
    |> change(params)
  end
end
