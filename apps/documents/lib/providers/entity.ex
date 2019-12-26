#
#  entity.ex
#  providers
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Provider.Entity do
  use 		Provider
  import 	Jsonb
  
  alias Data.Repo
  alias Model.Entity, as: Model

  def create(doc, data) do
    params = %{document_id: doc.id, data: data}

    %Model{}
    |> Model.changeset(params)
    |> Repo.insert()
  end

  def get(id) do
    Model
    |> Repo.get(id)
  end

  def search(doc, params) do
    Model
    |> where([d], d.document_id == ^doc.id)
    |> json_query(:data, params, where_type: :where)
    |> Repo.all
  end
  
  def delete(id: id) do
    Model
    |> Repo.get(id)
    |> Repo.delete!
  end

  def delete(entity: ent) do
    ent
    |> Repo.delete!
  end

  def list(doc_id: did) do
    Model
    |> where([d], d.document_id == ^did)
    |> Repo.all
  end

  def list(doc: doc) do
    Model
    |> where([d], d.document_id == ^doc.id)
    |> Repo.all
  end
end
