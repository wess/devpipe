#
#  entity.ex
#  models
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Model.Entity do
  use Schema

  @required_fields [:data]
  @optional_fields []

  @derive {Jason.Encoder, except: [:__meta__, :document]}
  schema "entities" do
    field :data, :map

    timestamps()

    belongs_to :document, Model.Document
  end

  def changeset(struct, params \\ %{}) do
    struct
    |> cast(params, @required_fields ++ @optional_fields) 
    |> validate_required(@required_fields)
    |> change(params)
  end
end
