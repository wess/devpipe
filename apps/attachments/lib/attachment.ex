#
#  model.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Attachment do
  require Logger
  use Schema
  use Waffle.Ecto.Schema
  
  @required_fields []
  @optional_fields []

  @derive {Jason.Encoder, except: [:__meta__,]}
  schema "attachments" do
    field :name,      :string
    field :file,      Definition.Type
    field :owner_id,  :string

    timestamps()
  end

  def changeset(struct, params \\ %{}) do
    struct
    |> cast(params, @required_fields ++ @optional_fields)
    |> cast_attachments(params, [:file])
    |> validate_required(@required_fields ++ [:file])
  end

  def url(model) do
    {model.attachment, model}
    |> Definition.url
  end

end
